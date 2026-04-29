import "dotenv/config";
import express from "express";

// Prevent unhandled async errors from crashing the process
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});
import cors from "cors";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chatRouter from "./routes/chat.js";
import conversationsRouter from "./routes/conversations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors({
  origin: process.env.APP_URL ?? "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));

app.use("/api/chat", chatRouter);
app.use("/api/conversations", conversationsRouter);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    env: process.env.APP_ENV ?? "development"
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    SUPABASE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ""
  });
});

app.use(express.static(join(ROOT, "app", "web")));

app.get("*", (_req, res) => {
  res.sendFile(join(ROOT, "app", "web", "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error("[server error]", err);
  res.status(500).json({ error: "Internal server error", detail: err.message });
});

app.listen(PORT, () => {
  console.log(`MindPortalix server running at http://localhost:${PORT}`);
  console.log(`  Environment : ${process.env.APP_ENV ?? "development"}`);
  console.log(`  Supabase    : ${process.env.NEXT_PUBLIC_SUPABASE_URL ? "configured" : "not configured"}`);
  console.log(`  OpenRouter  : ${process.env.OPENROUTER_API_KEY ? "configured" : "not configured"}`);
});

export default app;
