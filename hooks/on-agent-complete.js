import { reviewDraft } from "../src/orchestration/responses.js";

export function onAgentComplete(event) {
  return reviewDraft({
    draft: event?.content ?? "",
    route: event?.route ?? { agents: [] },
    threshold: event?.threshold ?? 7
  });
}
