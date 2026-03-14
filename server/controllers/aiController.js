import OpenAI from "openai";
import sql from "../configs/db.js";
import { clerkClient } from "@clerk/express";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import FormData from "form-data";
import fs from "fs";
import pdf from "pdf-parse/lib/pdf-parse.js";

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.OPENAI_API_KEY;

const FALLBACK_TEXT_MODELS = [
  GEMINI_TEXT_MODEL,
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
].filter((model, index, arr) => Boolean(model) && arr.indexOf(model) === index);

const AI = new OpenAI({
  apiKey: GEMINI_API_KEY,
  baseURL: GEMINI_BASE_URL,
});

const getProviderErrorDetails = (error) => {
  const status = error?.status || error?.response?.status;
  const providerMessage =
    error?.error?.message ||
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    "Unknown provider error";

  if (status === 403) {
    if (/reported as leaked/i.test(providerMessage)) {
      return {
        status,
        message:
          "Gemini rejected this key because it was reported as leaked. Generate a new API key in Google AI Studio and update GEMINI_API_KEY.",
        providerMessage,
      };
    }

    return {
      status,
      message:
        "Gemini request was forbidden (403). Check API key validity, API key restrictions, enabled Gemini API, billing/quota, and model availability for your region.",
      providerMessage,
    };
  }

  if (status === 401) {
    return {
      status,
      message:
        "Gemini request was unauthorized (401). Verify GEMINI_API_KEY/GOOGLE_API_KEY is present and correct.",
      providerMessage,
    };
  }

  if (status === 404 || /not found for API version/i.test(providerMessage)) {
    return {
      status,
      message:
        "Gemini model not found for this API version. Set GEMINI_TEXT_MODEL to a currently supported model such as gemini-2.5-flash or gemini-2.5-flash-lite.",
      providerMessage,
    };
  }

  return {
    status,
    message: providerMessage,
    providerMessage,
  };
};

const normalizeGeminiText = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part?.text || "").join("").trim();
};

const createNativeGeminiCompletion = async ({ model, prompt, maxTokens }) => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const { data } = await axios.post(endpoint, {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: maxTokens,
    },
  });

  const text = normalizeGeminiText(data);

  if (!text) {
    throw new Error("Gemini native response did not include text content.");
  }

  return {
    choices: [
      {
        message: {
          content: text,
        },
      },
    ],
  };
};

const createChatCompletionWithFallback = async ({ messages, maxTokens }) => {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in server environment variables."
    );
  }

  let lastError;
  const prompt = messages
    .map((item) =>
      typeof item?.content === "string"
        ? item.content
        : JSON.stringify(item?.content || "")
    )
    .join("\n");

  for (const model of FALLBACK_TEXT_MODELS) {
    try {
      return await AI.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
      });
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.response?.status;

      // Retry with fallback models only for common model/access issues.
      if (![400, 401, 403, 404, 429].includes(status)) {
        throw error;
      }
    }
  }

  // If OpenAI-compatible calls fail for all models, fallback to Gemini native REST API.
  for (const model of FALLBACK_TEXT_MODELS) {
    try {
      return await createNativeGeminiCompletion({
        model,
        prompt,
        maxTokens,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

export const generateArticle = async (req, res) => {
  try {
    const { userId } = req.auth();
    console.log("userId", userId);
    const { prompt, length } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    if (plan !== "premium" && free_usage >= 10) {
      return res.json({
        success: false,
        message: "Limit reached. Upgrade plan to continue.",
      });
    }

    const response = await createChatCompletionWithFallback({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      maxTokens: length,
    });

    const content = response.choices[0].message.content;

    await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, ${prompt}, ${content}, 'article')`;

    if (plan !== "premium") {
      await clerkClient.users.updateUser(userId, {
        private_metadata: {
          free_usage: free_usage + 1,
        },
      });
    }

    res.json({
      success: true,
      message: "Article generated successfully",
      content: content,
    });
  } catch (error) {
    const errorDetails = getProviderErrorDetails(error);
    console.error("generateArticle error:", errorDetails);
    res.json({
      success: false,
      message: errorDetails.message,
      provider_message: errorDetails.providerMessage,
      status: errorDetails.status,
    });
  }
};

export const generateBlogTitle = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    if (plan !== "premium" && free_usage >= 10) {
      return res.json({
        success: false,
        message: "Limit reached. Upgrade plan to continue.",
      });
    }

    const response = await createChatCompletionWithFallback({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      maxTokens: 100,
    });

    const content = response.choices[0].message.content;

    await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, ${prompt}, ${content}, 'blog-title')`;

    if (plan !== "premium") {
      await clerkClient.users.updateUser(userId, {
        private_metadata: {
          free_usage: free_usage + 1,
        },
      });
    }

    res.json({
      success: true,
      message: "Article generated successfully",
      content: content,
    });
  } catch (error) {
    const errorDetails = getProviderErrorDetails(error);
    console.error("generateBlogTitle error:", errorDetails);
    res.json({
      success: false,
      message: errorDetails.message,
      provider_message: errorDetails.providerMessage,
      status: errorDetails.status,
    });
  }
};

export const generateImage = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt, publish } = req.body;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is only available for premium users.",
      });
    }

    // Generate image using Clipdrop API
    const formData = new FormData();
    formData.append("prompt", prompt);
    const { data } = await axios.post(
      "https://clipdrop-api.co/text-to-image/v1",
      formData,
      {
        headers: {
          "x-api-key": process.env.CLIPDROP_API_KEY,
        },
        responseType: "arraybuffer",
      }
    );
    const base64Image = `data:image/png;base64,${Buffer.from(
      data,
      "binary"
    ).toString("base64")}`;

    // Upload to Cloudinary with improved error handling
    try {
      const uploadResult = await cloudinary.uploader.upload(base64Image, {
        folder: "quickai_images",
        resource_type: "image",
      });

      const secure_url = uploadResult.secure_url;

      await sql`INSERT INTO creations (user_id, prompt, content, type, publish) VALUES (${userId}, ${prompt}, ${secure_url}, 'image', ${
        publish ?? false
      })`;

      res.json({
        success: true,
        message: "Image generated successfully",
        content: secure_url,
      });
    } catch (cloudinaryError) {
      console.error("Cloudinary upload error:", cloudinaryError);
      res.json({
        success: false,
        message: `Cloudinary upload failed: ${cloudinaryError.message}`,
      });
    }
  } catch (error) {
    console.log(error.message);
    res.json({
      success: false,
      message: error.message,
    });
  }
};


export const removeImageBackground = async (req, res) => {
  try {
    const { userId } = req.auth();
    const image = req.file;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is only available for premium users.",
      });
    }

    const {secure_url} = await cloudinary.uploader.upload(image.path, {
      transformation: [ { effect: 'background_removal',
        background_removal: 'remove_the_background'
       } ],
    });
    

      await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, 'Remove background from image', ${secure_url}, 'image')`;

      res.json({
        success: true,
        message: "Image background removed successfully",
        content: secure_url,
      });
   
  } catch (error) {
    console.log(error.message);
    res.json({
      success: false,
      message: error.message,
    });
  }
};


export const removeImageObject = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { object } = req.body;
    const image = req.file;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is only available for premium users.",
      });
    }

    const {public_id} = await cloudinary.uploader.upload(image.path);
    const imageUrl = cloudinary.url(public_id, {
      transformation: [{effect: `gen_remove:${object}`}],
      resource_type: 'image'
    })
    

      await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, ${`Removed ${object} from image`}, ${imageUrl}, 'image')`;

      res.json({
        success: true,
        message: "Image background removed successfully",
        content: imageUrl,
      });
   
  } catch (error) {
    console.log(error.message);
    res.json({
      success: false,
      message: error.message,
    });
  }
};

export const resumeReview = async (req, res) => {
  try {
    const { userId } = req.auth();
    
    const resume = req.file;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is only available for premium users.",
      });
    }

    if(resume.size > 5 * 1024 * 1024){
      return res.json({
        success: false,
        message: "File size exceeds 5MB limit. Please upload a smaller file.",
      })
    }

    const dataBuffer = fs.readFileSync(resume.path);
    const pdfData = await pdf(dataBuffer);

    const prompt = `Review the following resume and provide constructive feedback on its strengths, weaknesses, and areas for improvement. Resume Content:\n\n${pdfData.text}`;

    const response = await createChatCompletionWithFallback({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      maxTokens: 1000,
    });

    const content = response.choices[0].message.content;

    await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, 'Review the uploaded resume', ${content}, 'resume-review')`;

      res.json({
        success: true,
        content: content,
      });
   
  } catch (error) {
    const errorDetails = getProviderErrorDetails(error);
    console.error("resumeReview error:", errorDetails);
    res.json({
      success: false,
      message: errorDetails.message,
      provider_message: errorDetails.providerMessage,
      status: errorDetails.status,
    });
  }
};