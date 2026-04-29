import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { SupabaseMemoryStore } from "../../storage/supabase-store.js";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  const store = new SupabaseMemoryStore(req.token);
  try {
    const conversations = await store.listConversations(req.user.id);
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  const store = new SupabaseMemoryStore(req.token);
  const { title } = req.body;
  try {
    const conversation = await store.createConversation({ userId: req.user.id, title });
    res.status(201).json({ conversation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/messages", async (req, res) => {
  const store = new SupabaseMemoryStore(req.token);
  try {
    const messages = await store.getMessages(req.params.id);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  const store = new SupabaseMemoryStore(req.token);
  try {
    await store.deleteConversation(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
