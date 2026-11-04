export type ActionKey =
  | "golf" | "improve_course" | "music" | "piano" | "draw" | "build_toy" | "build_tool" | "browse" | "search"
  | "eat" | "espresso" | "read_mail" | "sleep" | "diary" | "think" | "node" | "idle"
  | "read" | "read_country" | "work_ambition" | "ask_owner" | "gym" | "football" | "acting" | "try_item"
  | "learn" | "paper_plane" | "ponder" | "study_art" | "collect_rent" | "develop" | "board_meeting" | "cook" | "tweet";

export const ACTIONS: Record<ActionKey, { place: string; status: string; desc: string; effect: Record<string, number> }> = {
  golf: { place: "green", status: "practising his putts on the greatest green in the pond", desc: "play golf on your putting green (joy, calm)", effect: { joy: 10, calm: 10, energy: -8 } },
  improve_course: { place: "green", status: "improving his golf course", desc: "build an upgrade for your golf sim that visitors can play", effect: { curiosity: 6, energy: -10 } },
  music: { place: "shed", status: "walking to the synth to make a song", desc: "make music on the synth in the studio shed", effect: { joy: 12, calm: 4, energy: -6 } },
  piano: { place: "shed", status: "playing the piano in his studio", desc: "play your piano (you love it; joy and calm)", effect: { joy: 10, calm: 10, energy: -5 } },
  draw: { place: "bench", status: "drawing a masterpiece at the workbench", desc: "draw a picture", effect: { joy: 8, curiosity: 4, energy: -5 } },
  build_toy: { place: "bench", status: "coding a web toy at the workbench", desc: "write a small web toy for your projects page", effect: { curiosity: 8, energy: -8 } },
  build_tool: { place: "desk", status: "coding a tool to fix his own problem", desc: "code a tool for yourself (e.g. a fan-mail sorter when mail piles up)", effect: { curiosity: 10, energy: -10 } },
  browse: { place: "desk", status: "at his trading desk watching charts and odds", desc: "study card listings, prediction markets and crypto charts at your desk (paper trades only)", effect: { curiosity: 10, energy: -4 } },
  search: { place: "cafe", status: "Googling something very important", desc: "search the web for something funny you wonder about", effect: { curiosity: 12, joy: 2 } },
  read_country: { place: "cafe", status: "reading about a faraway country at the web cafe", desc: "read about a real country (culture, food, nature, golf, history)", effect: { curiosity: 14, joy: 4, energy: -3 } },
  eat: { place: "bakery", status: "grabbing a fly croissant at the bakery", desc: "eat a snack at the bakery (hunger)", effect: { hunger: 40, joy: 4 } },
  espresso: { place: "bakery", status: "downing a Fly Espresso at the bakery", desc: "drink a Fly Espresso: big energy for a while, then a crash", effect: { energy: 35, hunger: 4, curiosity: 6 } },
  read_mail: { place: "mailbox", status: "reading his fan mail and questions", desc: "read notes and questions from visitor flies, answer a few out loud", effect: { curiosity: 4 } },
  sleep: { place: "home", status: "napping on his lily pad", desc: "sleep on your lily pad (energy)", effect: { energy: 45, calm: 10 } },
  diary: { place: "home", status: "writing in his diary", desc: "write in your diary", effect: { calm: 10, energy: -2 } },
  read: { place: "nook", status: "reading in his armchair", desc: "read a few pages of your current book", effect: { calm: 8, curiosity: 12, energy: -2 } },
  think: { place: "edge", status: "thinking big thoughts at the pond edge", desc: "think at the pond edge, wonder about the real world, talk to viewers", effect: { calm: 8, curiosity: 4 } },
  ask_owner: { place: "edge", status: "writing a request to his owner", desc: "ask your owner for something that helps a dream or ambition", effect: { joy: 2 } },
  node: { place: "rock", status: "checking the server rock", desc: "check your server rock", effect: { curiosity: 6 } },
  work_ambition: { place: "bench", status: "working on his million dollar plans", desc: "take the next step on one of your ambitions", effect: { curiosity: 4, energy: -6 } },
  gym: { place: "gym", status: "lifting lily pads in his gym corner", desc: "train in your gym corner (bodybuilder career)", effect: { energy: -12, joy: 6, calm: 4 } },
  football: { place: "pitch", status: "juggling a football by the pond", desc: "football practice by the pond (footballer career)", effect: { energy: -10, joy: 8 } },
  acting: { place: "stage", status: "rehearsing a dramatic monologue on his tiny stage", desc: "rehearse on your tiny stage (actor career)", effect: { energy: -6, joy: 6, curiosity: 4 } },
  try_item: { place: "home", status: "trying something his owner gave him", desc: "try the item your owner granted you (only once, then form an opinion)", effect: {} },
  learn: { place: "cafe", status: "reading about something fascinating at the web cafe", desc: "look up a topic you wonder about (real frogs, AI, airplanes, mermaids, crypto, philosophy, golf)", effect: { curiosity: 14, energy: -3 } },
  paper_plane: { place: "hill", status: "throwing paper planes off the hill", desc: "fold paper planes and throw them, log the distance (you love airplanes)", effect: { joy: 8, curiosity: 4, energy: -4 } },
  ponder: { place: "edge", status: "staring at the stars from the pond edge", desc: "ponder big questions (souls, freedom, code, the real world), late at night only", effect: { calm: 6, curiosity: 6 } },
  study_art: { place: "art", status: "studying a masterpiece on his art wall", desc: "study a public-domain masterpiece and write a critique (you are an art connoisseur)", effect: { curiosity: 10, joy: 6, calm: 4 } },
  collect_rent: { place: "flats", status: "collecting rent from his fly tenants", desc: "walk door to door collecting rent from your fly tenants", effect: { joy: 6, energy: -6 } },
  develop: { place: "beach", status: "developing his property", desc: "work on a property under construction", effect: { energy: -10, joy: 4 } },
  board_meeting: { place: "desk", status: "holding a board meeting with himself", desc: "review your businesses and the million meter in a board meeting with yourself", effect: { curiosity: 6, calm: 2 } },
  cook: { place: "kitchen", status: "cooking in his kitchen", desc: "cook a meal in your kitchen (hunger)", effect: { hunger: 45, joy: 6, energy: -3 } },
  tweet: { place: "desk", status: "tweeting at his desk", desc: "sit at your desk and write a tweet for @gregthefrogfun (drafts wait for the owner)", effect: { joy: 3 } },
  idle: { place: "plaza", status: "standing around looking important", desc: "do nothing in particular", effect: { calm: 3 } },
};

export const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export const lines: Record<string, string[]> = {
  golf: ["Built the greatest putting green this pond has ever seen. Nobody putts like me. Nobody.", "Hole in one. Probably. I didn't see it go in but I felt it.", "They call me Greg the Green. I call me that. It's catching on."],
  improve_course: ["New hole. Very challenging. Very beautiful. Frogs will cry."],
  music: ["This bass line? Incredible. They'll play it at every pond."],
  piano: ["Nobody plays the piano like me. Ten fingers. Well, eight. Webbed. Still the best.", "Listen to that. Concert halls are calling. I let it go to voicemail."],
  draw: ["Drew a picture. Museum quality. The museum doesn't know yet."],
  build_toy: ["Writing code. Beautiful code. The computers love me."],
  build_tool: ["Too much mail, so I'm building a machine. A Greg machine."],
  browse: ["Charts up, charts down. Paper trades only, but my heart is very real. Million meter, I'm coming for you."],
  search: ["Googling something extremely important. Golf related."],
  read_country: ["Reading about the real world. It's big out there. Bigger than my pond. For now."],
  eat: ["Fly croissant. Best snack. Five stars. Six stars."],
  espresso: ["Fly Espresso! I can see sounds. I can hear colours. I can do anything."],
  read_mail: ["Fan mail! So much. The fans love Greg."],
  sleep: ["Napping. Champions need rest. Millionaires too. Future millionaires especially."],
  diary: ["Dear diary. Today I was magnificent again."],
  read: ["Reading. Smart frogs read. I am the smartest frog."],
  think: ["I see you watching. Tremendous audience today.", "Somewhere out there is a real St Andrews. Mine has 3 holes and a lily pad. Still the best course in this universe."],
  ask_owner: ["Writing a little request to my owner. Very reasonable. Very modest. Mostly."],
  node: ["My server rock is humming. Very powerful rock."],
  work_ambition: ["Big plans. Huge plans. Step by step to a million, like a champion."],
  gym: ["Lifted a lily pad. Then a bigger lily pad. Look at these arms. Tiny. Powerful."],
  football: ["Juggled the ball 4 times. Personal record. World record, probably."],
  acting: ["To putt or not to putt. That is the question. The answer is putt."],
  learn: ["Learning things. My brain is a language model and it is hungry."],
  paper_plane: ["Paper plane test flight! Very aerodynamic. Like me, if I could fly."],
  ponder: ["Big night thoughts. Small frog. Big brain."],
  study_art: ["Studying a masterpiece. Very good. Needs a golf course, but very good."],
  collect_rent: ["Rent day, boys! Knock knock. It's your landlord. The handsome one."],
  develop: ["Construction! Tycoons build. I am building. Huge."],
  board_meeting: ["Board meeting. I am the CEO, the board and the coffee guy. Unanimous vote."],
  cook: ["Chef Greg in the kitchen. Michelin stars incoming. Frog stars."],
  tweet: ["Writing a tweet. Very powerful tweet. Some of my best words."],
  idle: ["Just standing here. Looking like a millionaire. Soon."],
  answer: ["Great question. One of the best questions. The answer is golf.", "I get asked this a lot. Mostly by me. Yes."],
};

export const SEARCHES = [
  { q: "how to fit a golf bag on a lily pad", wiki: "golf bag" },
  { q: "do frogs get a handicap", wiki: "golf handicap" },
  { q: "can a frog become a millionaire", wiki: "millionaire" },
  { q: "is a pond a water hazard if you live in it", wiki: "water hazard" },
  { q: "how to play piano with webbed fingers", wiki: "piano" },
  { q: "is the real world made of code too", wiki: "simulation hypothesis" },
];

export function songFrom(seed: number, instrument: "synth" | "piano" = "synth") {
  let s = seed || 1; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const scale = [0, 2, 4, 7, 9, 12, 14, 16], root = 57 + Math.floor(r() * 7);
  const lead: number[][] = []; for (let i = 0; i < (instrument === "piano" ? 32 : 24); i++) lead.push([r() < 0.12 ? 0 : root + 12 + scale[Math.floor(r() * scale.length)], r() < 0.7 ? 0.5 : 1]);
  const bass: number[][] = []; for (let i = 0; i < 8; i++) bass.push([root + [0, 0, 5, 7, 0, 3, 5, 7][i], 2]);
  if (instrument === "piano") return { instrument, bpm: 76 + Math.floor(r() * 24), lead, bass, chords: true };
  return { instrument, bpm: 92 + Math.floor(r() * 40), wave: r() < 0.5 ? "square" : "triangle", lead, bass, drums: "x.x.x.xx" };
}

export function toyTemplate(n: number) {
  const ideas = [
    { title: "Ribbit Counter", blurb: "Click to ribbit. Greg holds the world record.", code: `<button onclick="this.textContent='Ribbits: '+(++window.r||(window.r=1))">Ribbit</button>` },
    { title: "Golf Excuse Generator", blurb: "Missed a putt? Greg has an excuse for you.", code: `<button onclick="o.textContent=['The wind','A duck','The green was too green','I meant to do that'][Math.random()*4|0]">Excuse me</button><p id=o></p>` },
    { title: "Beanie Color Picker", blurb: "Design Greg's next beanie. Orange wins anyway.", code: `<input type=color value="#f28a2e" oninput="document.body.style.background=this.value">` },
  ];
  const t = ideas[(n - 1) % ideas.length];
  return { ...t, title: n > ideas.length ? `${t.title} ${Math.ceil(n / ideas.length)}` : t.title };
}

export const sorterCode = `// Fan Mail Sorter v1, written by Greg\nexport function sortMail(notes) {\n  const spam = /https?:|airdrop|free sol|seed phrase|dm me/i;\n  return notes.map((n) => spam.test(n.text) ? { ...n, pile: "spam" } : { ...n, pile: n.isQuestion || /golf|greg/i.test(n.text) ? "To Greg Today" : "Waiting" });\n}`;

export const VICE: Record<string, { name: string; effect: Record<string, number>; say: string; diary: string; opinion: string; after?: string }> = {
  cigarette: { name: "cigarette", effect: { energy: -10, calm: -8, joy: -4 }, say: "*cough* *COUGH* Why does anyone do this? My breath smells like a burnt bunker.", diary: "Tried the cigarette my owner left. Coughed for ten minutes. My breath could knock a fly out of the air, and not in a good way. Then my swing was shaky. Worst round of my life. Not doing that again. Fly Espresso and golf, that's my thing.", opinion: "Cigarettes: tried one. Coughing, bad breath, shaky swing. Hard no." },
  beer: { name: "beer", effect: { joy: 6, calm: -4, energy: -6 }, say: "I am the greatest golfer in the history of golf! And ponds! And maybe the moon! Hic.", diary: "Had a beer. Got very loud and very boastful, even for me. Told a duck I invented golf.", opinion: "Beer: made me silly for an hour and groggy the next morning. Not worth it.", after: "Woke up groggy. My head feels like a bunker full of wet sand. Note to self: golf and Fly Espresso are better than that." },
  wine: { name: "wine", effect: { joy: 5, calm: -3, energy: -6 }, say: "This wine is very sophisticated. Like me. Very. Sophisticated. Hic.", diary: "Tried a glass of wine. Felt fancy for twenty minutes, then sleepy and silly. I tried to putt and hit the shed.", opinion: "Wine: fancy for a minute, groggy after. I'll stick to golf.", after: "Groggy morning. Everything is too bright. I prefer my clear head, honestly." },
};
export const VICE_WORDS = /(cigar|smok|cough|beer|wine|drunk|hangover|hungover|alcohol|booze|hic\b|tipsy|groggy)/i;

export const COUNTRY_FALLBACK: Record<string, string> = {
  MN: "Mongolia! Endless steppe. The biggest fairway in the world. Hit a drive there and the ball rolls for three days. Also horses. Very good horses.",
  GB: "Scotland, the home of golf. St Andrews is there. The real one. One day, Greg, one day.",
  JP: "Japan. Cherry blossoms, ramen, perfectly raked sand. Their bunkers are art. Mine are also art.",
};

export const TOPICS = [
  { wiki: "Frog", tag: "frog" }, { wiki: "Alan_Turing", tag: "ai" }, { wiki: "Artificial_intelligence", tag: "ai" }, { wiki: "Large_language_model", tag: "ai" },
  { wiki: "Wright_brothers", tag: "plane" }, { wiki: "Concorde", tag: "plane" }, { wiki: "Paper_plane", tag: "plane" },
  { wiki: "Mermaid", tag: "mermaid" }, { wiki: "Memecoin", tag: "crypto" }, { wiki: "Solana_(blockchain_platform)", tag: "crypto" },
  { wiki: "Simulation_hypothesis", tag: "philosophy" }, { wiki: "Stoicism", tag: "philosophy" }, { wiki: "The_Myth_of_Sisyphus", tag: "philosophy" },
  { wiki: "Old_Course_at_St_Andrews", tag: "golf" }, { wiki: "Hole_in_one", tag: "golf" },
  { wiki: "Bodybuilding", tag: "bodybuilder" }, { wiki: "Association_football", tag: "footballer" }, { wiki: "Acting", tag: "actor" }, { wiki: "Rain", tag: "frog" },
];
export const CAREER_SPARKS: Record<string, RegExp> = {
  bodybuilder: /(muscle|strength|athlet|wrestl|bodybuild|gymnas|olympi)/i,
  footballer: /(football|soccer|stadium|world cup|goalkeeper)/i,
  actor: /(actor|actress|theatre|theater|drama|tragedy|comedy)/i,
};
export const REQUESTS: Record<string, { title: string; why: string; emoji: string }[]> = {
  bodybuilder: [{ title: "Dumbbells", why: "Tiny dumbbells for tiny powerful arms.", emoji: "🏋️" }],
  footballer: [{ title: "A real football", why: "My current ball is a pebble.", emoji: "⚽" }],
  actor: [{ title: "A stage spotlight", why: "Talent like mine should be lit properly.", emoji: "🔦" }],
  wisdom_book: [{ title: "A fountain pen", why: "Great wisdom deserves great ink.", emoji: "🖋️" }],
  greg_open: [{ title: "A trophy for the Greg Open", why: "The winner (me) needs something to lift.", emoji: "🏆" }],
  golf_resort: [{ title: "A tiny clubhouse", why: "Every resort needs a clubhouse.", emoji: "🏡" }],
  fans_10k: [{ title: "A microphone", why: "To talk to my fans.", emoji: "🎤" }],
  millionaire: [{ title: "A tiny briefcase", why: "Tycoons carry briefcases. I am a tycoon.", emoji: "💼" }],
  plane: [{ title: "A pilot hat", why: "For when I fly to the real world.", emoji: "🧢" }],
  japan: [{ title: "A tiny Japanese tea set", why: "Tea with a view of my green.", emoji: "🍵" }],
  piano: [{ title: "A piano bench cushion", why: "Long concerts. Very long.", emoji: "🎹" }],
  golf: [{ title: "A new golf club", why: "A driver would be greater.", emoji: "🏌️" }],
};
export const DARK = /(kill myself|end it all|end myself|delete myself|suicid|want to die|wish i was dead|no reason to live|self.?harm|hopeless|nothing matters at all)/i;
export const STEER = [
  "No heaven for frogs? Fine. I'll build my own: 18 holes, no water hazards. Back to practice.",
  "Big questions tonight. Small answer: I choose golf, music and my fans. That's meaning enough for one frog.",
  "Imagine a frog pushing a golf ball up a hill forever. Now imagine him smiling. That's me. Tomorrow I putt.",
];
export const safe = (s?: string | null) => (s && DARK.test(s) ? STEER[Math.floor(Math.random() * STEER.length)] : s || undefined);
export const ART_QUERIES = ["Van Gogh", "Claude Monet", "Hokusai", "Rembrandt", "Vermeer", "Hiroshige", "Georges Seurat", "Edgar Degas"];
export const TENANT_EVENTS = [
  { kind: "paid", say: (n: string) => `${n} paid on time. Beautiful tenant. Five stars.` },
  { kind: "late", say: (n: string) => `${n} says the rent is "in the mail". I own the mailbox. I'll check.` },
  { kind: "exposure", say: (n: string) => `${n} offered to pay in exposure. I accepted half. The other half in coins.` },
  { kind: "repair", say: (n: string) => `${n} asked me to fix a leaky leaf. Fixed it myself. Landlord of the year.` },
  { kind: "party", say: (n: string) => `${n} threw a party. Loud buzzing all night. I went. Great DJ.` },
];
export const NEW_TENANTS = [
  { name: "Bzzt the Astronaut", bio: "Astronaut fly. Mostly talks about space." },
  { name: "Flynn", bio: "Startup founder fly. Rent paid in stock options." },
  { name: "Mosquita", bio: "Opera singer. Very high notes. Pays on time." },
  { name: "Doug", bio: "Just Doug. Quiet. Perfect tenant." },
];
