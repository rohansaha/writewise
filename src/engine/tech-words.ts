// Words that are not in the Hunspell en-US dictionary but are everyday vocabulary
// for people who write to AI assistants: software, product and internet terms.
// They are added to every check as a built-in personal dictionary.
export const TECH_WORDS: string[] = `
repo repos config configs env envs async await auth admin admins cli clis json yaml yml toml api apis url urls uri http https
localhost npm npx pnpm yarn node nodejs deno bun js ts jsx tsx css scss html svg png jpg jpeg webp gif pdf csv md readme changelog
sdk sdks mcp oauth sso jwt cors csrf xss cron regex regexp refactor refactors refactored refactoring middleware middlewares webhook webhooks
dev devs prod staging qa ci cd devops sre ui ux saas paas iaas backend backends frontend frontends fullstack monorepo monorepos microservice microservices
kubernetes k8s docker dockerfile github gitlab bitbucket vercel netlify cloudflare aws gcp azure firebase supabase heroku
typescript javascript python golang rust kotlin swift php ruby rails django flask fastapi express nestjs nextjs nuxt vite webpack rollup esbuild
react vue svelte angular tailwind bootstrap redux zustand graphql grpc rest restful websocket websockets sqlite postgres postgresql mysql mongodb redis
nosql orm prisma sequelize uuid uuids sha sha1 sha256 md5 base64 utf8 unicode ascii emoji emojis png
todo todos tbd eta fyi asap imo imho afaik iirc btw lol ok okay
ai llm llms gpt chatgpt claude anthropic openai gemini copilot midjourney prompt prompts prompting tokenizer tokenizers embedding embeddings
chatbot chatbots dataset datasets finetune finetuning finetuned hyperparameter hyperparameters inference
app apps webapp webapps plugin plugins addon addons extension extensions popup popups modal modals dropdown dropdowns tooltip tooltips
navbar sidebar sidebars toolbar toolbars footer header hero cta ctas onboarding signup signups login logins logout logouts username usernames
screenshot screenshots wireframe wireframes mockup mockups favicon favicons
upvote upvotes downvote downvotes hashtag hashtags selfie selfies vlog vlogs podcast podcasts livestream newsletter newsletters
google googled googling youtube instagram tiktok linkedin reddit discord slack zoom notion figma canva trello jira asana
iphone ipad macbook imac airpods android ios macos windows linux ubuntu wifi bluetooth usb hdmi
startup startups fintech edtech healthtech biotech blockchain crypto bitcoin ethereum nft nfts defi web3 metaverse
roadmap roadmaps backlog backlogs sprint sprints standup standups kanban okr okrs kpi kpis mvp mvps poc pocs
gb mb kb tb ms ns px rem em vh vw
`.split(/\s+/).filter(Boolean)
