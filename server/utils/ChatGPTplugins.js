const axios = require("axios");

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const extractGPT = async (input) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const baseUrl = process.env.OPENAI_API_BASE_URL || DEFAULT_OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const prompt = `${process.env.Collaborative_Prompt1 || ""}\n\n${input}`.trim();
  const systemPrompt =
    "You are an AI trading assistant. Respond ONLY with valid JSON (no code fences, no explanations). " +
    "Return an object with a single key `positions` whose value is an array of objects. " +
    "Each object must contain the keys 'Asset name', 'Asset ticker', 'Quantity', and 'Total Cost'.";

  try {
    console.log("Sending request to OpenAI chat completions...");

    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const message = response.data?.choices?.[0]?.message;
    if (!message) {
      throw new Error("No message returned from OpenAI");
    }

    let content = "";
    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part?.text) {
            return typeof part.text === "string"
              ? part.text
              : part.text?.value || "";
          }
          return part?.content || "";
        })
        .join("");
    } else {
      content = JSON.stringify(message.content ?? "");
    }

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("OpenAI response was empty");
    }

    return trimmed;
  } catch (error) {
    const details = error.response?.data || error.message;
    console.error("Request Error: failed to reach OpenAI", details);
    if (error.response?.status === 500) {
      throw new Error("OpenAI internal error. Please try again in a moment.");
    }
    throw new Error(
      error.response?.data?.error?.message ||
        "Failed to fetch collaborative strategy from OpenAI"
    );
  }
};

module.exports = extractGPT;
