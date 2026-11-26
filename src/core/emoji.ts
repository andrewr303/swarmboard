/**
 * Reaction names. Reactions are stored under Chat SDK's names (`thumbs_up`, `check`), the names
 * sync adapters send and expect, so a 👍 from Slack and one from the board are one reaction; Slack's
 * names (`+1`, `white_check_mark`) are aliases (original contract/emoji.ts:1-38, contract/emoji-table.ts,
 * generated there from Chat SDK's DEFAULT_EMOJI_MAP, chat 4.41).
 */

/** Canonical name → its characters (the first is the one shown) and Slack's names for it. */
const EMOJI_TABLE: Readonly<Record<string, { characters: readonly string[]; aliases: readonly string[] }>> = {
  '100': { characters: ['💯'], aliases: [] },
  thumbs_up: { characters: ['👍'], aliases: ['+1','thumbsup'] },
  thumbs_down: { characters: ['👎'], aliases: ['-1','thumbsdown'] },
  clap: { characters: ['👏'], aliases: [] },
  wave: { characters: ['👋'], aliases: [] },
  pray: { characters: ['🙏'], aliases: [] },
  muscle: { characters: ['💪'], aliases: [] },
  ok_hand: { characters: ['👌'], aliases: [] },
  point_up: { characters: ['👆'], aliases: [] },
  point_down: { characters: ['👇'], aliases: [] },
  point_left: { characters: ['👈'], aliases: [] },
  point_right: { characters: ['👉'], aliases: [] },
  raised_hands: { characters: ['🙌'], aliases: [] },
  shrug: { characters: ['🤷'], aliases: [] },
  facepalm: { characters: ['🤦'], aliases: [] },
  heart: { characters: ['❤️','❤'], aliases: [] },
  smile: { characters: ['😊'], aliases: ['slightly_smiling_face'] },
  laugh: { characters: ['😂','😆'], aliases: ['laughing','satisfied','joy'] },
  thinking: { characters: ['🤔'], aliases: ['thinking_face'] },
  sad: { characters: ['😢'], aliases: ['cry','white_frowning_face'] },
  cry: { characters: ['😭'], aliases: ['sob'] },
  angry: { characters: ['😠'], aliases: [] },
  love_eyes: { characters: ['😍'], aliases: ['heart_eyes'] },
  cool: { characters: ['😎'], aliases: ['sunglasses'] },
  wink: { characters: ['😉'], aliases: [] },
  surprised: { characters: ['😮'], aliases: ['open_mouth'] },
  worried: { characters: ['😟'], aliases: [] },
  confused: { characters: ['😕'], aliases: [] },
  neutral: { characters: ['😐'], aliases: ['neutral_face'] },
  sleeping: { characters: ['😴'], aliases: [] },
  sick: { characters: ['🤢'], aliases: ['nauseated_face'] },
  mind_blown: { characters: ['🤯'], aliases: ['exploding_head'] },
  relieved: { characters: ['😌'], aliases: [] },
  grimace: { characters: ['😬'], aliases: ['grimacing'] },
  rolling_eyes: { characters: ['🙄'], aliases: [] },
  hug: { characters: ['🤗'], aliases: ['hugging_face'] },
  zany: { characters: ['🤪'], aliases: ['zany_face'] },
  check: { characters: ['✅','✔️'], aliases: ['white_check_mark','heavy_check_mark'] },
  x: { characters: ['❌','✖️'], aliases: ['heavy_multiplication_x'] },
  question: { characters: ['❓','?'], aliases: [] },
  exclamation: { characters: ['❗'], aliases: [] },
  warning: { characters: ['⚠️'], aliases: [] },
  stop: { characters: ['🛑'], aliases: ['octagonal_sign'] },
  info: { characters: ['ℹ️'], aliases: ['information_source'] },
  fire: { characters: ['🔥'], aliases: [] },
  star: { characters: ['⭐'], aliases: [] },
  sparkles: { characters: ['✨'], aliases: [] },
  lightning: { characters: ['⚡'], aliases: ['zap'] },
  boom: { characters: ['💥'], aliases: [] },
  eyes: { characters: ['👀'], aliases: [] },
  green_circle: { characters: ['🟢'], aliases: ['large_green_circle'] },
  yellow_circle: { characters: ['🟡'], aliases: ['large_yellow_circle'] },
  red_circle: { characters: ['🔴'], aliases: [] },
  blue_circle: { characters: ['🔵'], aliases: ['large_blue_circle'] },
  white_circle: { characters: ['⚪'], aliases: [] },
  black_circle: { characters: ['⚫'], aliases: [] },
  rocket: { characters: ['🚀'], aliases: [] },
  party: { characters: ['🎉','🥳'], aliases: ['tada','partying_face'] },
  confetti: { characters: ['🎊'], aliases: ['confetti_ball'] },
  balloon: { characters: ['🎈'], aliases: [] },
  gift: { characters: ['🎁'], aliases: [] },
  trophy: { characters: ['🏆'], aliases: [] },
  medal: { characters: ['🥇'], aliases: ['first_place_medal'] },
  lightbulb: { characters: ['💡'], aliases: ['bulb'] },
  gear: { characters: ['⚙️'], aliases: [] },
  wrench: { characters: ['🔧'], aliases: [] },
  hammer: { characters: ['🔨'], aliases: [] },
  bug: { characters: ['🐛'], aliases: [] },
  link: { characters: ['🔗'], aliases: [] },
  lock: { characters: ['🔒'], aliases: [] },
  unlock: { characters: ['🔓'], aliases: [] },
  key: { characters: ['🔑'], aliases: [] },
  pin: { characters: ['📌'], aliases: ['pushpin'] },
  memo: { characters: ['📝'], aliases: [] },
  clipboard: { characters: ['📋'], aliases: [] },
  calendar: { characters: ['📅'], aliases: [] },
  clock: { characters: ['🕐'], aliases: ['clock1'] },
  hourglass: { characters: ['⏳'], aliases: [] },
  bell: { characters: ['🔔'], aliases: [] },
  megaphone: { characters: ['📢'], aliases: ['mega'] },
  speech_bubble: { characters: ['💬'], aliases: ['speech_balloon'] },
  email: { characters: ['📧'], aliases: [] },
  inbox: { characters: ['📥'], aliases: ['inbox_tray'] },
  outbox: { characters: ['📤'], aliases: ['outbox_tray'] },
  package: { characters: ['📦'], aliases: [] },
  folder: { characters: ['📁'], aliases: ['file_folder'] },
  file: { characters: ['📄'], aliases: ['page_facing_up'] },
  chart_up: { characters: ['📈'], aliases: ['chart_with_upwards_trend'] },
  chart_down: { characters: ['📉'], aliases: ['chart_with_downwards_trend'] },
  coffee: { characters: ['☕'], aliases: [] },
  pizza: { characters: ['🍕'], aliases: [] },
  beer: { characters: ['🍺'], aliases: [] },
  arrow_up: { characters: ['⬆️'], aliases: [] },
  arrow_down: { characters: ['⬇️'], aliases: [] },
  arrow_left: { characters: ['⬅️'], aliases: [] },
  arrow_right: { characters: ['➡️'], aliases: [] },
  refresh: { characters: ['🔄'], aliases: ['arrows_counterclockwise'] },
  sun: { characters: ['☀️'], aliases: ['sunny'] },
  cloud: { characters: ['☁️'], aliases: [] },
  rain: { characters: ['🌧️'], aliases: ['rain_cloud'] },
  snow: { characters: ['❄️'], aliases: ['snowflake'] },
  rainbow: { characters: ['🌈'], aliases: [] },
}

const CANONICAL = new Map<string, string>()
const SHOWN = new Map<string, string>()
const BY_CHARACTER = new Map<string, string>()

/** A character without its variation selector, so `❤️` and `❤` are one. */
const bare = (character: string): string => character.replace(/\uFE0F/g, '')

// A name is always its own canonical form, even where an earlier entry took it as an alias
// (`cry` is `sad`'s alias and its own name: it stays `cry`), as the original's add() does.
function add(name: string, characters: readonly string[], aliases: readonly string[]): void {
  CANONICAL.set(name, name)
  for (const alias of aliases) if (!CANONICAL.has(alias)) CANONICAL.set(alias, name)
  if (characters[0]) SHOWN.set(name, characters[0])
  for (const character of characters) if (!BY_CHARACTER.has(bare(character))) BY_CHARACTER.set(bare(character), name)
}

for (const [name, entry] of Object.entries(EMOJI_TABLE)) add(name, entry.characters, entry.aliases)
// Names the board accepted before it followed Chat SDK's table.
add('rotating_light', ['🚨'], [])
add('ship', ['🚢'], [])

/** A stored name in its canonical form: `+1` → `thumbs_up`, `joy` → `laugh`. Unknown names are their own. */
export const canonicalEmoji = (name: string): string => CANONICAL.get(name) ?? name

/** `eyes`, `:eyes:`, `+1`, or 👍 → a canonical short name; anything else throws. */
export function normalizeEmoji(input: string): string {
  const trimmed = input.trim()
  const named = /^:?([a-z0-9_+-]+):?$/i.exec(trimmed)
  if (named) return canonicalEmoji(named[1]!.toLowerCase())
  const name = BY_CHARACTER.get(bare(trimmed))
  if (name) return name
  throw new Error(`unknown emoji: ${input} (use a short name like eyes or thumbs_up)`)
}

/** The character a name shows as, or `:name:` for one the table doesn't know. */
export const displayEmoji = (name: string): string => SHOWN.get(canonicalEmoji(name)) ?? `:${name}:`
