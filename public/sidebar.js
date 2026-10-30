// Sidebar for the standalone pages (resources, settings, analytics). The chat app draws
// the same sidebar in App.tsx; keep the two in step.
//
// Usage, from a page's module script:
//   import { requireSignIn, mountSidebar } from "./sidebar.js";
//   await requireSignIn(supabaseClient);
//   mountSidebar(supabaseClient, "resources");
//
// The page needs <aside id="sidebar"> for wide screens and a button with
// data-open-menu to open the same sidebar as a drawer on small screens.

const ICONS = {
  chat: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z",
  box: "M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9",
  chart: "M4 20h16M7 16v-5M12 16V7M17 16v-8",
  signout: "M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 16l4-4-4-4M20 12H10",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  close: "M6 6l12 12M18 6 6 18",
};

const icon = (name, cls = "h-[18px] w-[18px] shrink-0 text-faint") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const navItem = (href, iconName, label, active) =>
  `<a href="${href}" ${active ? 'aria-current="page"' : ""} class="flex items-center gap-2 rounded-md px-2 py-1 ${
    active ? "bg-selected font-medium text-ink" : "text-ink-soft hover:bg-hover"
  }">${icon(iconName)}${label}</a>`;

const phoneHref = (phone) => {
  const digits = String(phone ?? "").replace(/[^\d+]/g, "");
  return digits.length >= 3 ? `tel:${digits}` : null;
};

export async function requireSignIn(supabaseClient) {
  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) {
    window.location.href = "login.html";
    return new Promise(() => {}); // stop the page while it redirects
  }
  return data.session;
}

export async function mountSidebar(supabaseClient, active) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  // Admins are listed in the app_admins table; is_admin() checks the signed-in user.
  const { data: isAdmin } = user ? await supabaseClient.rpc("is_admin") : { data: false };
  const { data: contacts } = await supabaseClient.from("notes").select("contact, phone").order("display_order");

  const contactRows = (contacts ?? [])
    .map((c) => {
      const href = phoneHref(c.phone);
      const inner = `<span class="truncate text-ink-soft">${escapeHtml(c.contact)}</span><span class="shrink-0 text-xs tabular-nums text-muted">${escapeHtml(c.phone)}</span>`;
      return href
        ? `<li><a href="${href}" class="flex items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-hover">${inner}</a></li>`
        : `<li class="flex items-center justify-between gap-3 px-2 py-1">${inner}</li>`;
    })
    .join("");

  const html = `
    <div class="flex h-full flex-col px-2 py-2.5 text-[14px]">
      <a href="index.html" class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
        <span class="flex h-5 w-5 items-center justify-center rounded bg-ink text-[11px] font-semibold text-white">L</span>
        <span class="font-semibold text-ink">LibSys</span>
      </a>
      <nav class="mt-2 space-y-px" aria-label="Main">
        ${navItem("index.html", "chat", "Support chat", active === "chat")}
        ${navItem("resources.html", "box", "Resources", active === "resources")}
        ${navItem("settings.html", "sliders", "Settings", active === "settings")}
        ${isAdmin === true ? navItem("analytics.html", "chart", "Usage", active === "usage") : ""}
      </nav>
      <section class="mt-5 min-h-0 flex-1 overflow-y-auto" aria-label="Urgent contacts">
        ${contactRows ? `<div class="px-2 pb-1 text-xs font-medium text-muted">Urgent contacts</div><ul>${contactRows}</ul>` : ""}
      </section>
      <div class="border-t border-line pt-2">
        ${user?.email ? `<div class="truncate px-2 py-1 text-xs text-muted">${escapeHtml(user.email)}</div>` : ""}
        <a href="set-password.html" class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-ink-soft hover:bg-hover">${icon("lock")}Change password</a>
        <button type="button" data-sign-out class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-ink-soft hover:bg-hover">${icon("signout")}Sign out</button>
      </div>
    </div>`;

  const aside = document.getElementById("sidebar");
  if (aside) aside.innerHTML = html;

  const drawer = document.createElement("div");
  drawer.className = "fixed inset-0 z-40 hidden lg:hidden";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-label", "Menu");
  drawer.innerHTML = `
    <div data-close-menu class="absolute inset-0 bg-[rgba(15,15,15,0.35)]"></div>
    <div class="absolute inset-y-0 left-0 w-[min(17rem,85vw)] bg-sidebar shadow-xl">
      <button type="button" data-close-menu aria-label="Close menu" class="absolute right-2 top-2.5 rounded-md p-1 text-faint hover:bg-hover hover:text-ink">${icon("close", "h-5 w-5")}</button>
      ${html}
    </div>`;
  document.body.appendChild(drawer);

  const openMenu = () => drawer.classList.remove("hidden");
  const closeMenu = () => drawer.classList.add("hidden");
  document.querySelectorAll("[data-open-menu]").forEach((b) => b.addEventListener("click", openMenu));
  drawer.querySelectorAll("[data-close-menu]").forEach((b) => b.addEventListener("click", closeMenu));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  document.querySelectorAll("[data-sign-out]").forEach((b) =>
    b.addEventListener("click", async () => {
      // The chat page keeps the current chat for this tab under libsys-chat:<user id>.
      try {
        Object.keys(sessionStorage).filter((k) => k.startsWith("libsys-chat:")).forEach((k) => sessionStorage.removeItem(k));
      } catch {
        // Nothing to clear.
      }
      await supabaseClient.auth.signOut();
      window.location.href = "login.html";
    }),
  );

  return user;
}
