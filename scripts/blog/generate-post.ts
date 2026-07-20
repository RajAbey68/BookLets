/**
 * Blog population CLI — generates a draft post via the Anthropic API using
 * the same instructions Claude Code follows interactively
 * (.claude/skills/blog-post/SKILL.md), so the standalone script and the
 * in-editor skill never drift apart.
 *
 * Usage:
 *   npm run blog:generate -- --topic "why hosts should reconcile monthly"
 *   npm run blog:generate -- --topic "..." --source-file notes.txt
 *   npm run blog:generate -- --topic "..." --source-url https://example.com/changelog
 *
 * Requires ANTHROPIC_API_KEY in the environment (see .env.example). Output
 * always has `draft: true` — review and flip it to `false` by hand.
 */
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import matter from "gray-matter";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const REPO_ROOT = path.resolve(__dirname, "../..");
const SKILL_PATH = path.join(REPO_ROOT, ".claude/skills/blog-post/SKILL.md");
const OUTPUT_DIR = path.join(REPO_ROOT, "content/blog");
const MAX_SOURCE_CHARS = 12_000;

interface CliArgs {
  topic: string;
  sourceFile?: string;
  sourceUrl?: string;
  tags?: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const topic = get("--topic");
  if (!topic) {
    throw new Error('Missing required --topic "<what the post should cover>"');
  }

  return {
    topic,
    sourceFile: get("--source-file"),
    sourceUrl: get("--source-url"),
    tags: get("--tags"),
    force: argv.includes("--force"),
  };
}

function loadSkillInstructions(): string {
  const raw = fs.readFileSync(SKILL_PATH, "utf8");
  // Strip the YAML frontmatter block — the body is the actual instructions.
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

async function loadSourceMaterial(args: CliArgs): Promise<string | null> {
  if (args.sourceFile) {
    const filePath = path.resolve(process.cwd(), args.sourceFile);
    return fs.readFileSync(filePath, "utf8").slice(0, MAX_SOURCE_CHARS);
  }
  if (args.sourceUrl) {
    const res = await fetch(args.sourceUrl);
    if (!res.ok) {
      throw new Error(`Fetching --source-url failed: HTTP ${res.status}`);
    }
    return (await res.text()).slice(0, MAX_SOURCE_CHARS);
  }
  return null;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

async function callClaude(system: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) before running blog:generate."
    );
  }
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error: HTTP ${res.status} — ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("Anthropic API returned no text content.");
  }
  return text.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const skillInstructions = loadSkillInstructions();
  const source = await loadSourceMaterial(args);
  const today = new Date().toISOString().slice(0, 10);

  const userPrompt = [
    `Write today's post. Topic/brief: ${args.topic}`,
    args.tags ? `Suggested tags: ${args.tags}` : null,
    source ? `Reference source material (ground claims in this, do not invent beyond it):\n\n${source}` : null,
    `Today's date is ${today} — use it as the frontmatter \`date\`.`,
    "Output ONLY the finished Markdown file content: the YAML frontmatter block followed by the post body. No commentary, no code fences around the whole thing.",
  ]
    .filter(Boolean)
    .join("\n\n");

  console.log(`Generating post for: ${args.topic}`);
  const fileContent = await callClaude(skillInstructions, userPrompt);

  const { data: frontmatter } = matter(fileContent);
  if (!frontmatter.title || !frontmatter.description) {
    throw new Error(
      "Generated content is missing required frontmatter (title/description) — not writing a file. Re-run or check the model output."
    );
  }

  const slug = `${today}-${slugify(String(frontmatter.title))}`;
  const outputPath = path.join(OUTPUT_DIR, `${slug}.md`);

  if (fs.existsSync(outputPath) && !args.force) {
    throw new Error(`${outputPath} already exists. Re-run with --force to overwrite.`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputPath, fileContent.endsWith("\n") ? fileContent : `${fileContent}\n`);

  console.log(`Wrote draft: ${path.relative(REPO_ROOT, outputPath)}`);
  console.log("Review it, then flip `draft: true` to `draft: false` when it's ready to publish.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
