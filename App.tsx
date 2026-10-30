
import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message, VQD, LKPTable, SupportContact } from './types';
import { QUICK_ACTIONS } from './constants';
import { sendChatMessage, ChatServiceError } from './services/chatService';
import { buildContext, buildGuideIndex, detectRequest, parseGuide, parseLKP, parseVQD, type GuideChunk, type GuideIndex } from './services/knowledge';
import { supabaseClient } from "./supabase"
import { library } from "./supabase/functions/_shared/library";
import { applySavedSettings } from "./services/settings";

// Same paths as public/sidebar.js, which draws the sidebar on the standalone pages.
const ICON_PATHS = {
  chat: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z",
  box: "M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9",
  chart: "M4 20h16M7 16v-5M12 16V7M17 16v-8",
  signout: "M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 16l4-4-4-4M20 12H10",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  phone: "M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  note: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12.5l4.5 4.5L19 7",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  stop: "M8 8h8v8H8z",
  offline: "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.6-2.8M19 13a10 10 0 0 0-2.4-1.7M2 9.5a15 15 0 0 1 4.2-2.7M22 9.5A15 15 0 0 0 11 5.1M12 20h.01",
  printer: "M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z",
  query: "M8 7l-5 5 5 5M16 7l5 5-5 5",
  tag: "M3 12V4h8l9 9-8 8zM7.5 7.5h.01",
};

const Icon: React.FC<{ name: keyof typeof ICON_PATHS; className?: string }> = ({ name, className = "h-[18px] w-[18px] shrink-0" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICON_PATHS[name]} />
  </svg>
);

type HastNode = { type: string; value?: string; children?: HastNode[]; properties?: { className?: string[] } };

const hastText = (node?: HastNode): string =>
  !node ? "" : node.type === "text" ? node.value ?? "" : (node.children ?? []).map(hastText).join("");

const BOOLEAN_LANGUAGES = ["boolean", "spydus", "query"];

// Code blocks in answers, with a copy button. Boolean queries are the main
// thing staff copy from here into Spydus, along with the subject and message
// of ink request and chat history emails.
const CodeBlock: React.FC<{ node?: HastNode }> = ({ node }) => {
  const [copied, setCopied] = useState(false);
  const code = node?.children?.find(child => child.type === "element");
  const text = hastText(code).replace(/\n$/, "");
  const language = (code?.properties?.className ?? []).find(c => c.startsWith("language-"))?.slice(9) ?? "";
  const label = BOOLEAN_LANGUAGES.includes(language.toLowerCase())
    ? "Boolean"
    : language.charAt(0).toUpperCase() + language.slice(1);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  return (
    <div className="code-block">
      <div className="mb-1 flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <button
          type="button"
          onClick={copy}
          className="-mr-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-soft hover:bg-hover"
        >
          <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
};

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ node }) => <CodeBlock node={node as HastNode} />,
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

const MessageItem: React.FC<{
  message: Message;
  onOptionClick: (text: string) => void;
  isLatest: boolean;
}> = ({ message, onOptionClick, isLatest }) => {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[10px] bg-bubble px-3 py-1.5 sm:max-w-[75%]">
          {message.content}
        </div>
      </div>
    );
  }

  // The empty placeholder added while waiting for a reply.
  if (!message.content) return null;

  const text = message.content
    .replace(/\[\[.*?\]\]/g, '')
    // A source line straight after a list would otherwise render inside the last step.
    .replace(/\n+(?=_?(From:|General tips))/g, '\n\n')
    .trim();

  return (
    <div>
      {message.isError ? (
        <p role="alert" className="rounded bg-danger-tint px-3.5 py-2.5">
          {text}
        </p>
      ) : (
        <div className="answer">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {text}
          </ReactMarkdown>
        </div>
      )}
      {isLatest && message.options && message.options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.options.map((opt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOptionClick(opt)}
              className="rounded-md border border-line-strong px-2.5 py-1 text-sm text-ink hover:bg-hover"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// The current chat, kept in sessionStorage for this tab only, per person.
const CHAT_KEY_PREFIX = 'libsys-chat:';

function loadSavedChat(userId: string): Message[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_KEY_PREFIX + userId) ?? '[]');
    return Array.isArray(saved) ? saved.map((m: Message) => ({ ...m, timestamp: new Date(m.timestamp) })) : [];
  } catch {
    return [];
  }
}

function saveChat(userId: string, messages: Message[]) {
  try {
    // Leaves out the empty placeholder for an answer still on its way.
    const kept = messages.filter(m => m.content);
    if (kept.length > 0) sessionStorage.setItem(CHAT_KEY_PREFIX + userId, JSON.stringify(kept));
    else sessionStorage.removeItem(CHAT_KEY_PREFIX + userId);
  } catch {
    // Storage blocked or full: the chat still works, it just isn't kept.
  }
}

// public/sidebar.js does the same when signing out from the other pages.
function clearSavedChats() {
  try {
    Object.keys(sessionStorage).filter(k => k.startsWith(CHAT_KEY_PREFIX)).forEach(k => sessionStorage.removeItem(k));
  } catch {
    // Nothing to clear.
  }
}

// The knowledge base is only served to signed-in staff (see supabase/functions/SOP-Fetch).
// One request per page load: React runs effects twice in development, and two
// at once can hit the edge function's resource limit. A failed load is tried
// once more after a short wait.
let knowledgeBaseRequest: Promise<{ name: string; path: string; content: string }[]> | null = null;

function loadKnowledgeBase() {
  const fetchOnce = async () => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch(`${library.supabase.url}/functions/v1/SOP-Fetch`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
    });
    if (!res.ok) throw new Error(`SOP-Fetch returned ${res.status}`);
    return res.json();
  };
  knowledgeBaseRequest ??= fetchOnce()
    .catch(() => new Promise((resolve) => setTimeout(resolve, 2000)).then(fetchOnce))
    .catch((err) => {
      knowledgeBaseRequest = null;
      throw err;
    });
  return knowledgeBaseRequest;
}

const App: React.FC = () => {
  const [vqdIndex, setVqdIndex] = useState<VQD[]>([]);
  const [lkpTables, setLkpTables] = useState<LKPTable[]>([]);
  const [view, setView] = useState<'chat' | 'admin'>('chat');
  const [user, setUser] = useState<any>(null);
  // Admins are listed in the app_admins table; is_admin() checks the signed-in user.
  const [isAdmin, setIsAdmin] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [selectedContact, setSelectedContact] = useState<SupportContact | null>(null);
  const [contactDraft, setContactDraft] = useState<SupportContact | null>(null);
  const [contactError, setContactError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [contacts, setContacts] = useState<SupportContact[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactsFailed, setContactsFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingNewChat, setConfirmingNewChat] = useState(false);
  const [kbStatus, setKbStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [guideIndex, setGuideIndex] = useState<GuideIndex | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isInterruptedRef = useRef(false);
  // A question asked while the guides are still loading, sent once they've loaded.
  const waitingRef = useRef<{ text: string; history: Message[]; modelMsgId: string } | null>(null);

useEffect(() => {
    loadContacts();
}, []);

async function loadContacts() {
    const { data, error } = await supabaseClient
        .from("notes")
        .select("*")
        .order("display_order");

    if (error) {
        console.error(error);
        setContactsFailed(true);
        return;
    }

    setContacts(data);
    setContactsLoaded(true);
}

  const openContact = (contact: SupportContact) => {
    setSelectedContact(contact);
    setContactDraft(null);
    setContactError('');
    setMenuOpen(false);
  };

  const closeContact = () => {
    setSelectedContact(null);
    setContactDraft(null);
    setContactError('');
  };

  const saveContact = async () => {
    if (!contactDraft) return;
    setIsSaving(true);
    setContactError('');

    const { error } = await supabaseClient
        .from("notes")
        .update({
            contact: contactDraft.contact,
            notes: contactDraft.notes,
            phone: contactDraft.phone,
            avail: contactDraft.avail
        })
        .eq("id", contactDraft.id);

    setIsSaving(false);

    if (error) {
        console.error(error);
        setContactError("The contact wasn't saved. Check you're still signed in, then try again.");
        return;
    }

    setSelectedContact(contactDraft);
    setContactDraft(null);
    await loadContacts();
};

  const signOut = async () => {
    clearSavedChats();
    await supabaseClient.auth.signOut();
    window.location.href = "login.html";
  };

  // Escape closes the contact dialog, or the menu on small screens.
  useEffect(() => {
    if (!selectedContact && !menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectedContact) closeContact();
      else setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedContact, menuOpen]);

  // Grow the message box with its text, up to its max height.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [inputText]);
  


  
  // Loads the person's account, settings and the guides. Runs on page load, and
  // again from Try again when the guides didn't load.
  const syncKnowledgeBase = async () => {
  let skipped = 0;
  let processed = 0;
  const guideChunks: GuideChunk[] = [];
  setKbStatus('loading');
  const { data } = await supabaseClient.auth.getUser();
  // Set together with the user, so the chat isn't saved as empty first.
  if (data.user) {
    const saved = loadSavedChat(data.user.id);
    if (saved.length > 0) setMessages(prev => (prev.length > 0 ? prev : saved));
  }
  setUser(data.user);
  if (data.user) supabaseClient.rpc('is_admin').then(({ data: admin }) => setIsAdmin(admin === true));
  // The person's own library details from the Settings page, if they've changed any.
  if (data.user) {
    const { data: saved, error } = await supabaseClient.from('user_settings').select('library').maybeSingle();
    if (error) console.error('Loading your settings failed:', error.message);
    applySavedSettings(saved?.library);
  }
  console.log(user);
  try {
    const files = await loadKnowledgeBase();

    let total = files.length;
let fetched = 0;
let failed = 0;

for (const file of files) {
  try {
    const fileName = file.name;
    const contentRaw = file.content;

    fetched++;

    const isPDF = /\.(pdf)$/i.test(fileName);
    const isVQD = fileName === "vqd.json";
    const isLKP = fileName === "lkp.json";
    const isText = /\.(txt|md|html|csv|log)$/i.test(fileName);

    if (isPDF) continue;

    // ---- JSON CONFIG FILES ----
    if (isVQD || isLKP) {
      if (isVQD) setVqdIndex(parseVQD(contentRaw));
      else setLkpTables(parseLKP(contentRaw));

      processed++;
      continue;
    }

    // ---- TEXT FILES ----
    if (isText) {
      guideChunks.push(...parseGuide(fileName, file.path, contentRaw));

      processed++;
      continue;
    }

    skipped++;
  } catch (err) {
    console.error(`Error processing ${file.name}:`, err);
    failed++;
  }
}

    const index = buildGuideIndex(guideChunks);
    setGuideIndex(index);
    setKbStatus(index.guides > 0 ? 'ready' : 'failed');

    if (fetched === total && failed === 0) {
      console.log(`Knowledge Base fully synced (${fetched}/${total})`);
    } else {
      console.log(
        `Knowledge Base incomplete: ${fetched}/${total} fetched, ${failed} failed`
      );
    }
  } catch (err) {
    console.warn("Auto-sync skipped or failed:", err);
    setKbStatus('failed');
  }
};

  useEffect(() => {
    syncKnowledgeBase();
  }, []);

  // Keeps the chat for this browser tab, so a reload or a visit to another page
  // doesn't lose it. Not localStorage: desk PCs are shared, and chats can
  // mention customers. Sign-out clears it.
  useEffect(() => {
    if (user) saveChat(user.id, messages);
  }, [messages, user]);


  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // Confirmed in the header rather than with confirm(), which some browsers
  // (including embedded ones) block without showing anything.
  const startNewChat = () => {
    setConfirmingNewChat(false);
    setMessages([]);
    setInputText('');
    setIsTyping(false);
    isInterruptedRef.current = true;
    waitingRef.current = null;
    setView('chat');
  };

  const stopGeneration = () => {
    isInterruptedRef.current = true;
    waitingRef.current = null;
    setIsTyping(false);
    setMessages(prev => {
      if (prev.length > 0 && prev[prev.length - 1].role === 'model' && !prev[prev.length - 1].content) {
        return prev.slice(0, -1);
      }
      return prev;
    });
  };

  const parseOptions = (text: string): string[] => {
    const matches = text.match(/\[\[(.*?)\]\]/g);
    if (!matches) return [];
    return matches.map(m => m.slice(2, -2));
  };


  
  const linkify = (text: string): React.ReactNode[] => {
  const regex =
    /(https?:\/\/[^\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

  return text.split(regex).map((part, i) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2 hover:text-accent-hover break-all"
        >
          {part}
        </a>
      );
    }

    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(part)) {
      return (
        <a
          key={i}
          href={`mailto:${part}`}
          className="text-accent underline underline-offset-2 hover:text-accent-hover break-all"
        >
          {part}
        </a>
      );
    }

    return part;
  });
};



  const handleSend = (text: string = inputText) => {
    if (!text.trim() || isTyping) return;

    isInterruptedRef.current = false;
    const history = messages;
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    const modelMsgId = (Date.now() + 1).toString();
    const modelMsg: Message = {
      id: modelMsgId,
      role: 'model',
      content: '',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg, modelMsg]);
    setInputText('');
    setIsTyping(true);

    // Answered without the guides, it would be made up, so a question asked
    // while they're still loading waits for them.
    if (kbStatus === 'loading') {
      waitingRef.current = { text, history, modelMsgId };
      return;
    }
    requestAnswer(text, history, modelMsgId);
  };

  useEffect(() => {
    const waiting = waitingRef.current;
    if (!waiting || kbStatus === 'loading') return;
    waitingRef.current = null;
    requestAnswer(waiting.text, waiting.history, waiting.modelMsgId);
  }, [kbStatus]);

  const requestAnswer = async (text: string, history: Message[], modelMsgId: string) => {
    try {
      // Recent turns only; error messages aren't part of the conversation.
      const chatHistory = history
        .filter(m => !m.isError && m.content.trim())
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));

      // Ink requests don't use the guides; anything else needs them.
      if (kbStatus === 'failed' && detectRequest(text, chatHistory) !== 'ink') {
        setMessages(prev =>
          prev.map(m => m.id === modelMsgId
            ? { ...m, content: "LibSys couldn't load its guides, so it hasn't answered this. Use Try again at the top of the chat, then ask again.", isError: true }
            : m)
        );
        setInputText(current => current || text);
        return;
      }

      const context = buildContext(text, chatHistory, guideIndex, vqdIndex, lkpTables);


const response = await sendChatMessage(text, chatHistory, context);

if (isInterruptedRef.current) return;

// Use the text returned by the Edge function
let finalContent = response.text || "";
let options = parseOptions(finalContent);

// Update the chat message with final content and options
setMessages(prev =>
  prev.map(m =>
    m.id === modelMsgId
      ? { ...m, content: finalContent, options }
      : m
  )
);

} catch (error) {
  if (isInterruptedRef.current) return;
  console.error("Chat Error:", error);
  const errorMsg = error instanceof ChatServiceError
    ? error.message
    : error instanceof Error && error.message.includes('exceeds the maximum number')
    ? "The information found is too large for me to process in one go. Please try being more specific about the file name or location you need." 
    : "Sorry, I hit a snag, Please try again.";
  
  setMessages(prev =>
    prev.map(m => m.id === modelMsgId ? { ...m, content: errorMsg, isError: true } : m)
  );
} finally {
  setIsTyping(false);
}
  }

  const navItemClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2 py-1 ${
      active ? 'bg-selected font-medium text-ink' : 'text-ink-soft hover:bg-hover'
    }`;

  const fieldClass =
    "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-ink outline-none focus:border-accent";

  const phoneHref = (phone: string) => {
    const digits = (phone ?? '').replace(/[^\d+]/g, '');
    return digits.length >= 3 ? `tel:${digits}` : null;
  };

  const sidebar = (
    <div className="flex h-full flex-col px-2 py-2.5 text-[14px]">
      <a href="index.html" className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-ink text-[11px] font-semibold text-white">L</span>
        <span className="font-semibold text-ink">LibSys</span>
      </a>

      <nav className="mt-2 space-y-px" aria-label="Main">
        <a href="index.html" aria-current="page" className={navItemClass(true)}>
          <span className="text-faint"><Icon name="chat" /></span>
          Support chat
        </a>
        <a href="resources.html" className={navItemClass(false)}>
          <span className="text-faint"><Icon name="box" /></span>
          Resources
        </a>
        <a href="settings.html" className={navItemClass(false)}>
          <span className="text-faint"><Icon name="sliders" /></span>
          Settings
        </a>
        {isAdmin && (
          <a href="analytics.html" className={navItemClass(false)}>
            <span className="text-faint"><Icon name="chart" /></span>
            Usage
          </a>
        )}
      </nav>

      <section className="mt-5 min-h-0 flex-1 overflow-y-auto" aria-labelledby="contacts-heading">
        <h2 id="contacts-heading" className="px-2 pb-1 text-xs font-medium text-muted">Urgent contacts</h2>
        <ul>
          {contacts.map((contact, idx) => (
            <li key={contact.id ?? idx}>
              <button
                type="button"
                onClick={() => openContact(contact)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left hover:bg-hover"
              >
                <span className="truncate text-ink-soft">{contact.contact}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{contact.phone}</span>
              </button>
            </li>
          ))}
          {contactsLoaded && contacts.length === 0 && (
            <li className="px-2 py-1 text-muted">No contacts yet</li>
          )}
          {contactsFailed && (
            <li className="px-2 py-1 text-muted">Contacts didn't load</li>
          )}
        </ul>
      </section>

      <div className="border-t border-line pt-2">
        {user?.email && (
          <div className="truncate px-2 py-1 text-xs text-muted" title={user.email}>{user.email}</div>
        )}
        <a href="set-password.html" className={navItemClass(false)}>
          <span className="text-faint"><Icon name="lock" /></span>
          Change password
        </a>
        <button type="button" onClick={signOut} className={navItemClass(false)}>
          <span className="text-faint"><Icon name="signout" /></span>
          Sign out
        </button>
      </div>
    </div>
  );

  const knowledgeBaseStatus = {
    loading: { className: 'text-muted', text: 'Loading guides…' },
    ready: { className: 'text-muted', text: `${(guideIndex?.guides ?? 0).toLocaleString()} guides` },
    failed: { className: 'text-danger', text: "Guides didn't load" },
  }[kbStatus];

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-surface text-ink">
      <aside className="hidden w-60 shrink-0 bg-sidebar lg:block">{sidebar}</aside>

      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-[rgba(15,15,15,0.35)]" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[min(17rem,85vw)] bg-sidebar shadow-xl">
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
              className="absolute right-2 top-2.5 rounded-md p-1 text-faint hover:bg-hover hover:text-ink"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 px-3 text-sm">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1 text-ink-soft hover:bg-hover lg:hidden"
          >
            <Icon name="menu" className="h-5 w-5" />
          </button>
          <span className="px-1 text-ink-soft">Support chat</span>
          <div className="ml-auto flex items-center gap-1">
            <span
              className={`px-2 text-xs ${knowledgeBaseStatus.className} ${confirmingNewChat ? 'hidden sm:inline' : ''}`}
              role="status"
            >
              {knowledgeBaseStatus.text}
            </span>
            {kbStatus === 'failed' && !confirmingNewChat && (
              <button
                type="button"
                onClick={() => syncKnowledgeBase()}
                className="rounded-md px-2 py-1 text-ink-soft hover:bg-hover"
              >
                Try again
              </button>
            )}
            {messages.length > 0 && !confirmingNewChat && (
              <button
                type="button"
                onClick={() => setConfirmingNewChat(true)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-ink-soft hover:bg-hover"
              >
                <Icon name="plus" className="h-4 w-4" />
                New chat
              </button>
            )}
            {messages.length > 0 && confirmingNewChat && (
              <div className="flex items-center gap-1" role="group" aria-label="Start a new chat">
                <span className="hidden whitespace-nowrap px-1 text-ink-soft sm:inline">Clear this chat?</span>
                <button
                  type="button"
                  onClick={() => setConfirmingNewChat(false)}
                  className="rounded-md px-2 py-1 text-ink-soft hover:bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={startNewChat}
                  className="whitespace-nowrap rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-hover"
                >
                  Clear chat
                </button>
              </div>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto w-full max-w-[720px] px-6 pb-10 pt-[12vh] sm:px-14">
              <h1 className="text-[32px] font-bold leading-tight tracking-[-0.01em]">Support chat</h1>
              <p className="mt-1.5 text-[16px] text-muted">
                Ask about Spydus, Monitor, the self-checks or printers, or get a Boolean query written for you.
              </p>

              <h2 className="mt-8 text-xs font-medium text-muted">Suggested</h2>
              <ul className="-mx-2 mt-1">
                {QUICK_ACTIONS.map(action => (
                  <li key={action.label}>
                    <button
                      type="button"
                      onClick={() => handleSend(action.prompt)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                    >
                      <span className="text-faint"><Icon name={action.icon} /></span>
                      {action.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[720px] space-y-6 px-6 py-6 sm:px-14">
              {messages.map((m, idx) => (
                <MessageItem key={m.id} message={m} onOptionClick={handleSend} isLatest={idx === messages.length - 1} />
              ))}
              {isTyping && (
                <p className="thinking text-muted" role="status">
                  {kbStatus === 'loading' ? 'Waiting for the guides to load…' : 'Searching the guides…'}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 px-4 pb-4 sm:px-14">
          <form
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            className="mx-auto flex max-w-[720px] items-end gap-2 rounded-xl bg-surface px-3 py-2 shadow-composer"
          >
            <label htmlFor="chat-input" className="sr-only">Message</label>
            <textarea
              id="chat-input"
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={messages.length === 0 ? "Ask a question" : "Ask a follow-up"}
              rows={1}
              className="max-h-48 flex-1 resize-none bg-transparent py-1 text-[15px] text-ink outline-none placeholder:text-faint"
            />
            {isTyping ? (
              <button
                type="button"
                onClick={stopGeneration}
                aria-label="Stop"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-white"
              >
                <Icon name="stop" className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim()}
                aria-label="Send"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:bg-[#efefee] disabled:text-faint"
              >
                <Icon name="arrowUp" className="h-4 w-4" />
              </button>
            )}
          </form>
          {/* Questions go to outside AI services, which may keep what's typed. */}
          <p className="mx-auto mt-1.5 max-w-[720px] px-1 text-center text-xs text-muted">
            Don't include customers' names, card numbers or contact details.
          </p>
        </div>
      </main>

      {selectedContact && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(15,15,15,0.35)] p-4 pt-[12vh]"
          onClick={closeContact}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-title"
            className="modal-shadow max-h-[80dvh] w-full max-w-md overflow-y-auto rounded-[10px] bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 px-5 pt-5">
              <h2 id="contact-title" className="text-xl font-semibold leading-snug">
                {contactDraft ? 'Edit contact' : selectedContact.contact}
              </h2>
              <div className="flex shrink-0 items-center gap-1">
                {/* Only admins can change contacts (the database enforces this). */}
                {!contactDraft && isAdmin && (
                  <button
                    type="button"
                    onClick={() => setContactDraft({ ...selectedContact })}
                    className="rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-hover"
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeContact}
                  aria-label="Close"
                  className="rounded-md p-1 text-faint hover:bg-hover hover:text-ink"
                >
                  <Icon name="close" className="h-5 w-5" />
                </button>
              </div>
            </div>

            {!contactDraft ? (
              <dl className="space-y-0.5 px-5 pb-5 pt-3 text-sm">
                <div className="flex gap-3 py-1">
                  <dt className="flex w-28 shrink-0 items-center gap-2 text-muted"><span className="text-faint"><Icon name="phone" className="h-4 w-4" /></span>Phone</dt>
                  <dd className="min-w-0">
                    {phoneHref(selectedContact.phone)
                      ? <a href={phoneHref(selectedContact.phone)!} className="tabular-nums text-accent hover:underline">{selectedContact.phone}</a>
                      : <span className="tabular-nums">{selectedContact.phone}</span>}
                  </dd>
                </div>
                <div className="flex gap-3 py-1">
                  <dt className="flex w-28 shrink-0 items-center gap-2 text-muted"><span className="text-faint"><Icon name="clock" className="h-4 w-4" /></span>Available</dt>
                  <dd className="min-w-0">{selectedContact.avail || <span className="text-faint">Empty</span>}</dd>
                </div>
                <div className="flex gap-3 py-1">
                  <dt className="flex w-28 shrink-0 items-start gap-2 pt-px text-muted"><span className="mt-0.5 text-faint"><Icon name="note" className="h-4 w-4" /></span>Notes</dt>
                  <dd className="min-w-0 whitespace-pre-wrap">
                    {selectedContact.notes?.trim()
                      ? linkify(selectedContact.notes)
                      : <span className="text-faint">Empty</span>}
                  </dd>
                </div>
              </dl>
            ) : (
              <form
                className="space-y-3 px-5 pb-5 pt-4 text-sm"
                onSubmit={(e) => { e.preventDefault(); saveContact(); }}
              >
                <div>
                  <label htmlFor="contact-name" className="mb-1 block text-[13px] text-muted">Name</label>
                  <input
                    id="contact-name"
                    value={contactDraft.contact}
                    onChange={(e) => setContactDraft({ ...contactDraft, contact: e.target.value })}
                    className={fieldClass}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="contact-phone" className="mb-1 block text-[13px] text-muted">Phone</label>
                  <input
                    id="contact-phone"
                    type="tel"
                    value={contactDraft.phone}
                    onChange={(e) => setContactDraft({ ...contactDraft, phone: e.target.value })}
                    className={`${fieldClass} tabular-nums`}
                  />
                </div>
                <div>
                  <label htmlFor="contact-avail" className="mb-1 block text-[13px] text-muted">Available</label>
                  <input
                    id="contact-avail"
                    value={contactDraft.avail ?? ''}
                    onChange={(e) => setContactDraft({ ...contactDraft, avail: e.target.value })}
                    placeholder="Mon–Fri 8:30am–5pm"
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label htmlFor="contact-notes" className="mb-1 block text-[13px] text-muted">Notes</label>
                  <textarea
                    id="contact-notes"
                    value={contactDraft.notes ?? ''}
                    onChange={(e) => setContactDraft({ ...contactDraft, notes: e.target.value })}
                    rows={5}
                    className={fieldClass}
                  />
                </div>
                {contactError && (
                  <p role="alert" className="rounded bg-danger-tint px-3 py-2">{contactError}</p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setContactDraft(null); setContactError(''); }}
                    className="rounded-md px-3 py-1.5 text-ink-soft hover:bg-hover"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                  >
                    {isSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
