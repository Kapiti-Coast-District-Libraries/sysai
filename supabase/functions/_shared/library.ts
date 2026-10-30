// The details LibSys needs about the library it runs for. Another library on the
// same Spydus database copies LibSys and edits this file; see "Setting LibSys up
// for another library" in README.md.
//
// The chat app, the standalone pages (vite.config.ts fills them in) and both edge
// functions read it. It lives in supabase/functions/_shared because that's where
// edge functions can share code from when they're deployed.

export const library = {
  // "You are LibSys, the support assistant for … staff."
  name: 'Kāpiti Coast District Libraries',
  // What staff call the library: "WHAT KĀPITI USES", "Kāpiti's borrowers". Boolean
  // query requests that use it ("Kāpiti borrowers") look up the Institutions table.
  shortName: 'Kāpiti',
  // At the foot of the sign-in and set-password pages.
  council: 'Kāpiti Coast District Council',
  // The sign-in box shows name@ this as an example.
  emailDomain: 'kapiticoast.govt.nz',

  // The library's own code in Spydus's Institutions table (INS), and that table's
  // description of it. Boolean queries add + BRWHI: <code> for the library's borrowers.
  institution: { code: 'KCDC', name: 'Kapiti Coast' },
  // Other libraries on the same Spydus database, named in the Boolean query rules.
  sharedWith: ['Carterton', 'Hutt City'],

  // Branches with their codes in Spydus's Location Code table (E), in the order
  // staff see them as buttons. The first two are the examples in the Boolean query
  // rules; a library with one branch can list just that one.
  branches: [
    { name: 'Paraparaumu', code: 'PARA' },
    { name: 'Waikanae', code: 'WAI' },
    { name: 'Ōtaki', code: 'OTA' },
    { name: 'Paekākāriki', code: 'PAE' },
  ],

  spydus: {
    // The release the staff desks run.
    version: '2025R4.1',
    // The release most of the Spydus Help guides in the guides repo are written for.
    helpVersion: '2025R1',
  },

  // The library's other systems, one line each for the AI, after the Spydus line.
  systems: [
    'The public computers are **APNK** Chromeboxes and Chromebooks. Public computer bookings, guest passes and public printing are run in **APNK Monitor**.',
    "The public wifi is run by APNK. LibSys doesn't know its network name or password, so never state or guess one, even in a button.",
    "The self-check and self-return machines and staff RFID pads are **Bibliotheca**. The Bibliotheca guides in LibSys are for **staffConnect**, the software for the staff RFID pads at the desk. They don't cover the self-check machines themselves.",
  ],

  // WHO TO CONTACT in the AI's instructions: where staff find the numbers, then
  // who handles what. Use the names from the Urgent contacts list (the notes
  // table), which has their phone numbers.
  contacts: {
    intro: 'These are all in the **Urgent contacts** list in the LibSys sidebar, which has their phone numbers and hours:',
    list: [
      { name: 'Council IT', covers: 'staff computers, the staff network and internet, email and staff logins' },
      { name: 'APNK Support', covers: 'the public computers and the public wifi' },
      { name: 'Monitor', covers: 'APNK Monitor, public computer bookings and public printing' },
      { name: 'Civica', covers: 'bugs or errors in Spydus' },
      { name: 'Bibliotheca', covers: 'RFID, the self-check and self-return machines, and staff RFID pads' },
    ],
  },

  printer: {
    // The colours staff can pick for an ink request.
    tonerColours: ['Black', 'Cyan', 'Magenta', 'Yellow'],
    // The ink request email reads "Waikanae library requests a Cyan <cartridge>."
    cartridge: '212x Toner Cartridge',
  },

  // The Supabase project, from Project Settings → API. The publishable key is
  // meant to be public; never put the secret or service role key here.
  supabase: {
    url: 'https://ocexpnnzfglknklsotcd.supabase.co',
    publishableKey: 'sb_publishable_9qzdgSJ2XjgmFNW3Hc0nMQ_n9jOPyQw',
  },

  // Where the site is published. The chat function only answers pages from here
  // (and from http://localhost:3000, for npm run dev).
  siteOrigin: 'https://kapiti-coast-district-libraries.github.io',

  // The private GitHub repo SOP-Fetch reads the guides from. Its GITHUB_TOKEN
  // secret needs read access to it.
  guides: { owner: 'Kapiti-Coast-District-Libraries', repo: 'LibSysAIKB', branch: 'main' },
};
