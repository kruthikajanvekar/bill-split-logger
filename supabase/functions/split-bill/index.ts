import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function buildSplitSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "bill_split",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          currency: { type: "string" },
          total: { type: "number" },
          subtotal: { type: "number" },
          tax: { type: "number" },
          tip: { type: "number" },
          fees: { type: "number" },
          line_items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                quantity: { type: "number" },
                price: { type: "number" },
                total: { type: "number" },
                assigned_to: { type: "array", items: { type: "string" } },
                split_rule: { type: "string" },
              },
              required: ["name", "total"],
            },
          },
          splits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                person: { type: "string" },
                amount: { type: "number" },
                items: { type: "array", items: { type: "string" } },
              },
              required: ["person", "amount"],
            },
          },
          math: { type: "string" },
          notes: { type: "string" },
        },
        required: ["total", "splits", "math"],
      },
    },
  };
}

function extractStructuredOutput(data: any) {
  const output = data?.output?.[0]?.content?.[0];
  if (!output) return null;
  if (output.type === "output_json") return output.json;
  if (output.type === "output_text") {
    try {
      return JSON.parse(output.text);
    } catch {
      return null;
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const providedKey = (body?.openai_key as string | undefined) || "";
  const activeKey = providedKey || OPENAI_API_KEY;

  if (body?.ping) {
    return new Response(
      JSON.stringify({ ok: true, configured: Boolean(activeKey) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(
      JSON.stringify({ error: "Supabase env not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Missing bearer token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return new Response(
      JSON.stringify({ error: userError?.message || "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!activeKey) {
    return new Response(
      JSON.stringify({ error: "OpenAI key not set" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const prompt = body?.prompt as string | undefined;
  const images = (body?.images as Array<{ base64: string; type?: string }>) || [];

  if (!prompt) {
    return new Response(
      JSON.stringify({ error: "Missing prompt" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const imageInputs = images.map((image) => ({
    type: "input_image",
    image_url: `data:${image.type || "image/jpeg"};base64,${image.base64}`,
  }));

  const payload = {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }, ...imageInputs],
      },
    ],
    response_format: buildSplitSchema(),
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${activeKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    return new Response(
      JSON.stringify({ error: data?.error || "OpenAI request failed" }),
      { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const result = extractStructuredOutput(data);
  return new Response(
    JSON.stringify({ result, raw: data }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
