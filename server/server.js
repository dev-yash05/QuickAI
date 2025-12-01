import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { clerkMiddleware,requireAuth } from '@clerk/express'
import aiRouter from './routes/aiRoutes.js';
import connectCloudinary from './configs/cloudinary.js';
import userRouter from './routes/userRoutes.js';

const app = express();

// Initialize Cloudinary
await connectCloudinary();

app.use(cors({
  origin: process.env.CLIENT_URL || "https://quick-ai-zeta-hazel.vercel.app", // MUST match your frontend URL exactly
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true // Required if you are sending cookies or headers
}));
app.use(express.json());
app.use(clerkMiddleware());

app.get('/', (req,res)=>{
    res.send('Hello from QuickAI Server!');
});

// Use the aiRouter for '/api/ai' routes
// The auth middleware is already applied in the router
app.use('/api/ai', aiRouter);
app.use('/api/user', userRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running on port 3000'));
