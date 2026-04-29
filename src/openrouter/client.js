const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function createChatCompletionRequest({
  model,
  messages,
  apiKey = process.env.OPENROUTER_API_KEY,
  baseUrl = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL,
  appUrl = process.env.APP_URL,
  appTitle = "MindPortalix"
}) {
  if (!model) {
    throw new Error("OpenRouter request requires a model");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("OpenRouter request requires at least one message");
  }

  return {
    url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: buildHeaders({ apiKey, appUrl, appTitle }),
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        stream: false
      })
    }
  };
}

export async function callOpenRouter({ fetchImpl = fetch, ...requestOptions }) {
  const request = createChatCompletionRequest(requestOptions);
  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }
  return response.json();
}

function buildHeaders({ apiKey, appUrl, appTitle }) {
  const headers = {
    "Content-Type": "application/json",
    "X-Title": appTitle
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (appUrl) {
    headers["HTTP-Referer"] = appUrl;
  }

  return headers;
}
