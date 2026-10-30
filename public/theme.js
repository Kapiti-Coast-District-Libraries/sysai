// Tailwind settings shared by every page. Load right after the Tailwind CDN script.
// Colours come from theme.css so both stay in step.
tailwind.config = {
  theme: {
    extend: {
      colors: {
        sidebar: "var(--sidebar)",
        surface: "var(--surface)",
        ink: { DEFAULT: "var(--ink)", soft: "var(--ink-soft)" },
        muted: "var(--muted)",
        faint: "var(--faint)",
        line: { DEFAULT: "var(--line)", strong: "var(--line-strong)" },
        hover: "var(--hover)",
        selected: "var(--selected)",
        bubble: "var(--bubble)",
        code: "var(--code)",
        accent: { DEFAULT: "var(--accent)", hover: "var(--accent-hover)", tint: "var(--accent-tint)" },
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: { DEFAULT: "var(--danger)", tint: "var(--danger-tint)" },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        composer: "0 0 0 1px rgba(15,15,15,0.08), 0 2px 6px rgba(15,15,15,0.06)",
      },
    },
  },
};
