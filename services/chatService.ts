import { systemInstruction } from "../constants";
import { supabaseClient } from "../supabase"
import { library } from "../supabase/functions/_shared/library";

async function logUserRPD(userId: string) {
  const { error } = await supabaseClient.rpc('log_rpd', { uid: userId });
  if (error) {
    console.error('Failed to log RPD:', error.message);
  } else {
    console.log('RPD logged for user', userId);
  }
}
// The libsys-chat Supabase edge function (source in supabase/functions/libsys-chat).
// Tool definitions (ink request, chat history) live there too.
const CHAT_URL = `${library.supabase.url}/functions/v1/libsys-chat`;

// Errors whose message is written for staff and can be shown as-is.
export class ChatServiceError extends Error {}

export const sendChatMessage = async (
  message: string,
  history: { role: "user" | "model"; content: string }[],
  context = ""
) => {
  // context is the guide excerpts (or ink request steps) from services/knowledge.ts.
  const fullInstructions = context ? `${systemInstruction()}\n\n${context}` : systemInstruction();

const { data: { session } } = await supabaseClient.auth.getSession();

if (!session) {
  throw new ChatServiceError("Your sign-in has expired. Please sign out and sign in again.");
}

const res = await fetch(CHAT_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`
  },
  body: JSON.stringify({
    message,
    history,
    instructions: fullInstructions
  })
});


  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new ChatServiceError(detail?.error || "Sorry, I hit a snag, Please try again.");
  }
const { data: { user } } = await supabaseClient.auth.getUser();

if (user) {
  await logUserRPD(user.id);
}
  return res.json();
};
