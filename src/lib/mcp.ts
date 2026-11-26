import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { invoke } from "@/lib/ipc";
import { accountKey } from "@/lib/accountScope";
import { SOURCE_PRECEDENCE, getPerSourceSnapshot, settingsSnapshotFor } from "@/lib/settingsRuntime";
import { getCachedPluginComponents } from "@/lib/plugins/pluginLoader";
import { connectorAccessToken, renewConnectorToken } from "@/lib/connectorTokens";
import { getSecret, setSecret } from "@/lib/secureStore";
import {
  answerInputRequests,
  isGoogleWorkspaceMcp,
  isInputRequired,
  MCP_CALL,
  workspaceHeaders,
  workspaceMcpMeta,
  type McpApprovalAsk,
} from "@/lib/mcpElicitation";

export type McpTransportKind = "http" | "stdio";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Signed in with OAuth: its tokens are in the keychain (connectorTokens), not in `headers`. */
  oauth?: boolean;
  enabled: boolean;
  source?: string;
}

export interface ConnectorCatalogEntry {
  name: string;
  url: string;
  description: string;
  auth: "none" | "token" | "oauth";
  logo?: string;
  color?: string;
  developer?: string;
  developerUrl?: string;
  docsUrl?: string;
  longDescription?: string;
  category?: string;
  type?: "interactive" | "desktop" | "web";
  popularity?: number;
  trending?: boolean;
  addedAt?: string;
  oauthScopes?: string[];
  oauthManualClient?: boolean;
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** The tools its makers publish, shown before it's connected; the server's own list replaces them after. */
  tools?: string[];
  supportUrl?: string;
  privacyUrl?: string;
}

/** Nyxs's own Google OAuth client (a desktop one, marked for an AI agent), so Gmail and Google Calendar
 *  connect in one click as in Claude. It comes from the build's environment (.env.local, CI secrets)
 *  and stays out of the public repo; without it the page asks for the user's own client. */
const GOOGLE_OAUTH = {
  clientId: import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID ?? "",
  clientSecret: import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET ?? "",
};

const OAUTH_CLIENTS_KEY = "optimicer.oauthClients.v1";

/** A manual OAuth client's secret is kept in the keychain; its id stays in localStorage. */
const clientSecretAccount = (name: string) => accountKey(`mcp-oauth-client:${name}`);

function loadOAuthClients(): Record<string, { clientId?: string; clientSecret?: string }> {
  try {
    const map = JSON.parse(localStorage.getItem(accountKey(OAUTH_CLIENTS_KEY)) || "{}");
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function saveOAuthClients(map: Record<string, { clientId?: string; clientSecret?: string }>): void {
  try {
    localStorage.setItem(accountKey(OAUTH_CLIENTS_KEY), JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

export function getOAuthClient(name: string): { clientId: string } {
  return { clientId: loadOAuthClients()[name]?.clientId || "" };
}

/** The secret of a manual OAuth client. One an earlier version left in localStorage moves to
 *  the keychain on the way. */
export async function getOAuthClientSecret(name: string): Promise<string> {
  const map = loadOAuthClients();
  const legacy = map[name]?.clientSecret;
  if (legacy) {
    await setSecret(clientSecretAccount(name), legacy);
    delete map[name].clientSecret;
    saveOAuthClients(map);
    return legacy;
  }
  return (await getSecret(clientSecretAccount(name))) ?? "";
}

export function setOAuthClient(name: string, v: { clientId: string; clientSecret: string }): void {
  const map = loadOAuthClients();
  map[name] = { clientId: v.clientId };
  saveOAuthClients(map);
  void setSecret(clientSecretAccount(name), v.clientSecret);
}

const CN_ICON = "/connector-icons";

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", description: "Search and read documentation for any public GitHub repository.", auth: "none", color: "#6b7280", developer: "DeepWiki", developerUrl: "https://deepwiki.com", docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp", longDescription: "Connect DeepWiki to search and read the documentation of any public GitHub repository. Useful for quickly understanding unfamiliar codebases, APIs and libraries without leaving the chat.", category: "Código", type: "web", popularity: 60, addedAt: "2024-11-01" },
  { name: "Cloudflare-Docs", url: "https://docs.mcp.cloudflare.com/mcp", description: "Search the Cloudflare developer documentation.", auth: "none", logo: `${CN_ICON}/cloudflare-color.svg`, color: "#f38020", developer: "Cloudflare", developerUrl: "https://developers.cloudflare.com", docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/", category: "Código", type: "web", popularity: 50, addedAt: "2024-12-01" },
  { name: "Hugging Face", url: "https://huggingface.co/mcp", description: "Explore models, datasets and Spaces on Hugging Face.", auth: "token", logo: `${CN_ICON}/huggingface-color.svg`, color: "#ff9d00", developer: "Hugging Face", developerUrl: "https://huggingface.co", docsUrl: "https://huggingface.co/settings/mcp", category: "Datos", type: "web", popularity: 70, trending: true, addedAt: "2025-01-15" },
  { name: "GitHub", url: "https://api.githubcopilot.com/mcp/", description: "Repos, issues, pull requests and code search on GitHub.", auth: "oauth", logo: `${CN_ICON}/github.svg`, color: "#e5e5e5", developer: "GitHub", developerUrl: "https://github.com", docsUrl: "https://docs.github.com", category: "Código", type: "web", popularity: 100, trending: true, addedAt: "2024-10-01" },
  { name: "Linear", url: "https://mcp.linear.app/mcp", description: "Create and search issues, projects and cycles in Linear.", auth: "oauth", logo: `${CN_ICON}/linear.svg`, color: "#5e6ad2", developer: "Linear", developerUrl: "https://linear.app", docsUrl: "https://linear.app/docs", category: "Productividad", type: "web", popularity: 80, addedAt: "2025-02-01" },
  { name: "Notion", url: "https://mcp.notion.com/mcp", description: "Search, read and update pages in your Notion workspace.", auth: "oauth", logo: `${CN_ICON}/notion.svg`, color: "#e5e5e5", developer: "Notion", developerUrl: "https://notion.so", docsUrl: "https://developers.notion.com", category: "Productividad", type: "web", popularity: 85, trending: true, addedAt: "2025-03-01" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp", description: "Inspect errors, issues and releases tracked in Sentry.", auth: "oauth", logo: `${CN_ICON}/sentry.svg`, color: "#8d5494", developer: "Sentry", developerUrl: "https://sentry.io", docsUrl: "https://docs.sentry.io", category: "Estado", type: "web", popularity: 55, addedAt: "2025-04-01" },
  { name: "Stripe", url: "https://mcp.stripe.com", description: "Query payments, customers and invoices in Stripe.", auth: "token", logo: `${CN_ICON}/stripe.svg`, color: "#635bff", developer: "Stripe", developerUrl: "https://stripe.com", docsUrl: "https://docs.stripe.com", category: "Servicios financieros", type: "web", popularity: 75, addedAt: "2025-05-01" },
  { name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", description: "Draft replies, summarize threads and search your inbox.", auth: "oauth", logo: `${CN_ICON}/gmail.svg`, color: "#ea4335", developer: "Google", developerUrl: "https://google.com", docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server", longDescription: "Connect Gmail so the agent can find important emails, read whole threads for context, draft replies and stay on top of your inbox — all from the chat. Official Google Workspace remote MCP server.", category: "Correo y mensajes", type: "web", popularity: 95, trending: true, addedAt: "2025-05-20", oauthScopes: ["https://www.googleapis.com/auth/gmail.modify"], oauthManualClient: true, oauthClientId: GOOGLE_OAUTH.clientId, oauthClientSecret: GOOGLE_OAUTH.clientSecret, supportUrl: "https://support.google.com/mail", privacyUrl: "https://policies.google.com/privacy", tools: ["apply_sensitive_message_label", "apply_sensitive_thread_label", "create_draft", "create_label", "get_draft", "get_message", "get_thread", "label_message", "label_thread", "list_drafts", "list_labels", "mark_message_spam", "mark_thread_spam", "search_threads", "trash_message", "trash_thread", "unlabel_message", "unlabel_thread", "unmark_message_spam", "unmark_thread_spam", "untrash_message", "untrash_thread", "update_message_labels"] },
  { name: "Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", description: "Manage your schedule and coordinate meetings.", auth: "oauth", logo: `${CN_ICON}/googlecalendar.svg`, color: "#4285f4", developer: "Google", developerUrl: "https://google.com", docsUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server", longDescription: "Connect Google Calendar so the agent can check your availability, create and update events, and coordinate meetings effortlessly. Official Google Workspace remote MCP server.", category: "Productividad", type: "web", popularity: 90, trending: true, addedAt: "2025-05-20", oauthScopes: ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.freebusy", "https://www.googleapis.com/auth/calendar.events"], oauthManualClient: true, oauthClientId: GOOGLE_OAUTH.clientId, oauthClientSecret: GOOGLE_OAUTH.clientSecret, supportUrl: "https://support.google.com/calendar", privacyUrl: "https://policies.google.com/privacy", tools: ["create_event", "delete_event", "get_event", "list_calendars", "list_events", "respond_to_event", "search_events", "suggest_time", "update_event"] },
  { name: "Atlassian", url: "https://mcp.atlassian.com/v2/mcp", description: "Search and update Jira issues and Confluence pages.", auth: "oauth", logo: `${CN_ICON}/atlassian.svg`, color: "#0052cc", developer: "Atlassian", developerUrl: "https://www.atlassian.com", docsUrl: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/", longDescription: "Connect Atlassian so the agent can search, create and update Jira issues and read or write Confluence pages. Summarize work, file tickets from the chat and keep documentation in sync, with the same permissions as your Atlassian account.", category: "Productividad", type: "web", popularity: 88, trending: true, addedAt: "2025-05-01" },
  { name: "Canva", url: "https://mcp.canva.com/mcp", description: "Create, find and edit designs in Canva.", auth: "oauth", logo: `${CN_ICON}/canva.svg`, color: "#8b3dff", developer: "Canva", developerUrl: "https://www.canva.com", docsUrl: "https://www.canva.com/help/mcp-agent-setup/", longDescription: "Connect Canva so the agent can generate designs, search your existing ones, fill brand templates and export the results. Useful for turning a brief written in the chat into presentations, social posts and documents.", category: "Diseño", type: "web", popularity: 82, trending: true, addedAt: "2025-06-17" },
  { name: "Supabase", url: "https://mcp.supabase.com/mcp", description: "Manage Supabase projects, databases and edge functions.", auth: "oauth", logo: `${CN_ICON}/supabase.svg`, color: "#3ecf8e", developer: "Supabase", developerUrl: "https://supabase.com", docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp", longDescription: "Connect Supabase so the agent can design tables, run SQL, apply migrations, read logs and deploy edge functions. Point it at a development project: it acts with the same rights as your Supabase account.", category: "Bases de datos", type: "web", popularity: 78, trending: true, addedAt: "2025-10-03" },
  { name: "Zapier", url: "https://mcp.zapier.com/api/v1/connect", description: "Run actions in thousands of apps through Zapier.", auth: "oauth", logo: `${CN_ICON}/zapier.svg`, color: "#ff4f00", developer: "Zapier", developerUrl: "https://zapier.com", docsUrl: "https://docs.zapier.com/mcp/home", longDescription: "Connect Zapier to let the agent take actions across thousands of apps — send messages, update CRMs, add spreadsheet rows and more. You choose which actions the agent can use in your Zapier MCP settings.", category: "Automatización", type: "web", popularity: 76, addedAt: "2025-04-15" },
  { name: "Context7", url: "https://mcp.context7.com/mcp", description: "Up-to-date docs and code examples for any library.", auth: "none", logo: `${CN_ICON}/context7.svg`, color: "#059669", developer: "Upstash", developerUrl: "https://context7.com", docsUrl: "https://context7.com/docs/overview", longDescription: "Connect Context7 so the agent pulls current, version-specific documentation and code examples for libraries and frameworks straight into the conversation. Avoids answers based on outdated APIs; works without an account.", category: "Código", type: "web", popularity: 74, trending: true, addedAt: "2025-04-20" },
  { name: "Airtable", url: "https://mcp.airtable.com/mcp", description: "Read and update records in your Airtable bases.", auth: "oauth", logo: `${CN_ICON}/airtable.svg`, color: "#18bfff", developer: "Airtable", developerUrl: "https://www.airtable.com", docsUrl: "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server", longDescription: "Connect Airtable so the agent can explore your bases, query tables and create or update records. Handy for reporting, cleaning data and keeping trackers up to date from the chat.", category: "Datos", type: "web", popularity: 68, addedAt: "2026-02-10" },
  { name: "Dropbox", url: "https://mcp.dropbox.com/mcp", description: "Search, read and organize files in Dropbox.", auth: "oauth", logo: `${CN_ICON}/dropbox.svg`, color: "#0061ff", developer: "Dropbox", developerUrl: "https://www.dropbox.com", docsUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", longDescription: "Connect Dropbox so the agent can find files, read their contents and manage folders and sharing. Bring documents into the conversation without downloading them first.", category: "Archivos y documentos", type: "web", popularity: 66, addedAt: "2026-01-20" },
  { name: "PayPal", url: "https://mcp.paypal.com/mcp", description: "Manage invoices, orders and transactions in PayPal.", auth: "oauth", logo: `${CN_ICON}/paypal.svg`, color: "#003087", developer: "PayPal", developerUrl: "https://www.paypal.com", docsUrl: "https://developer.paypal.com/ai-tools/mcp-server", longDescription: "Connect PayPal so the agent can create and send invoices, look up transactions, handle disputes and manage orders and subscriptions. Every action runs against your own PayPal business account.", category: "Servicios financieros", type: "web", popularity: 64, addedAt: "2025-05-15" },
  { name: "Miro", url: "https://mcp.miro.com/", description: "Read and create content on Miro boards.", auth: "oauth", logo: `${CN_ICON}/miro.svg`, color: "#ffd02f", developer: "Miro", developerUrl: "https://miro.com", docsUrl: "https://developers.miro.com/docs/miro-mcp", longDescription: "Connect Miro so the agent can read the context of your boards and add diagrams, sticky notes and documents to them. Turn brainstorming sessions into specs, or specs into visual plans.", category: "Diseño", type: "web", popularity: 62, addedAt: "2025-10-28" },
  { name: "ClickUp", url: "https://mcp.clickup.com/mcp", description: "Manage tasks, docs and time tracking in ClickUp.", auth: "oauth", logo: `${CN_ICON}/clickup.svg`, color: "#7b68ee", developer: "ClickUp", developerUrl: "https://clickup.com", docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server", longDescription: "Connect ClickUp so the agent can search your workspace, create and update tasks, comment, and read or write docs. Keep projects moving without leaving the chat.", category: "Productividad", type: "web", popularity: 58, addedAt: "2025-11-12" },
  { name: "Netlify", url: "https://mcp.netlify.com/mcp", description: "Create, deploy and manage Netlify sites.", auth: "oauth", logo: `${CN_ICON}/netlify.svg`, color: "#05bdba", developer: "Netlify", developerUrl: "https://www.netlify.com", docsUrl: "https://docs.netlify.com/welcome/build-with-ai/netlify-mcp-server/", longDescription: "Connect Netlify so the agent can create projects, deploy sites, manage environment variables and forms, and check deploy status. Ship what you build in the chat straight to production.", category: "Código", type: "web", popularity: 57, addedAt: "2025-06-20" },
  { name: "Exa", url: "https://mcp.exa.ai/mcp", description: "Real-time web search and page crawling built for AI.", auth: "none", logo: `${CN_ICON}/exa.svg`, color: "#1f40ed", developer: "Exa", developerUrl: "https://exa.ai", docsUrl: "https://exa.ai/docs/get-started/exa-mcp", longDescription: "Connect Exa to give the agent fast web search, code search and page crawling tuned for language models. Works without an account, within Exa's free usage limits.", category: "Datos", type: "web", popularity: 56, addedAt: "2025-06-05" },
  { name: "Neon", url: "https://mcp.neon.tech/mcp", description: "Manage Neon Postgres projects, branches and queries.", auth: "oauth", logo: `${CN_ICON}/neon.svg`, color: "#00e599", developer: "Neon", developerUrl: "https://neon.com", docsUrl: "https://neon.com/docs/ai/neon-mcp-server", longDescription: "Connect Neon so the agent can create projects and branches, run SQL and prepare schema migrations on a branch before applying them. A safe way to evolve a Postgres database from natural language.", category: "Bases de datos", type: "web", popularity: 53, addedAt: "2025-05-07" },
  { name: "Intercom", url: "https://mcp.intercom.com/mcp", description: "Search conversations, tickets and contacts in Intercom.", auth: "oauth", logo: `${CN_ICON}/intercom.svg`, color: "#1f8ded", developer: "Intercom", developerUrl: "https://www.intercom.com", docsUrl: "https://developers.intercom.com/docs/guides/mcp", longDescription: "Connect Intercom so the agent can look up customer conversations, tickets and contacts. Spot recurring issues, summarize feedback and get context on a customer before replying.", category: "Soporte", type: "web", popularity: 52, addedAt: "2025-05-22" },
  { name: "Todoist", url: "https://ai.todoist.net/mcp", description: "Add, organize and complete your Todoist tasks.", auth: "oauth", logo: `${CN_ICON}/todoist.svg`, color: "#e44332", developer: "Doist", developerUrl: "https://www.todoist.com", docsUrl: "https://www.todoist.com/help/articles/connect-todoist-to-an-ai-assistant-xMSzFfHng", longDescription: "Connect Todoist so the agent can capture tasks, reschedule them, organize projects and review what's due. Plan your day or turn meeting notes into to-dos from the chat.", category: "Productividad", type: "web", popularity: 51, addedAt: "2025-09-16" },
  { name: "Microsoft Learn", url: "https://learn.microsoft.com/api/mcp", description: "Search official Microsoft and Azure documentation.", auth: "none", logo: `${CN_ICON}/microsoft.svg`, color: "#00a4ef", developer: "Microsoft", developerUrl: "https://learn.microsoft.com", docsUrl: "https://learn.microsoft.com/en-us/training/support/mcp", longDescription: "Connect Microsoft Learn so the agent searches and reads official, up-to-date documentation and code samples for Azure, .NET, Microsoft 365 and more. No account needed.", category: "Código", type: "web", popularity: 49, addedAt: "2025-06-18" },
  { name: "Webflow", url: "https://mcp.webflow.com/mcp", description: "Edit Webflow sites, pages and CMS collections.", auth: "oauth", logo: `${CN_ICON}/webflow.svg`, color: "#146ef5", developer: "Webflow", developerUrl: "https://webflow.com", docsUrl: "https://developers.webflow.com/mcp/reference/overview", longDescription: "Connect Webflow so the agent can manage CMS collections and items, update page content and SEO metadata, and publish your sites. Keep content fresh without opening the Designer.", category: "Diseño", type: "web", popularity: 48, addedAt: "2025-06-24" },
  { name: "Square", url: "https://mcp.squareup.com/mcp", description: "Work with payments, orders and catalog in Square.", auth: "oauth", logo: `${CN_ICON}/square.svg`, color: "#3e4348", developer: "Block", developerUrl: "https://squareup.com", docsUrl: "https://developer.squareup.com/docs/mcp", longDescription: "Connect Square so the agent can look up payments, manage orders, customers, inventory and catalog items across the Square APIs. Answer questions about your business without exporting reports.", category: "Servicios financieros", type: "web", popularity: 47, addedAt: "2025-05-15" },
  { name: "Wix", url: "https://mcp.wix.com/mcp", description: "Build and manage Wix sites, stores and bookings.", auth: "oauth", logo: `${CN_ICON}/wix.svg`, color: "#0c6efc", developer: "Wix", developerUrl: "https://www.wix.com", docsUrl: "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp", longDescription: "Connect Wix so the agent can manage your sites' products, orders, bookings, blog posts and other business data, and look up the Wix developer docs. Run day-to-day site tasks from the chat.", category: "Diseño", type: "web", popularity: 46, addedAt: "2025-06-10" },
  { name: "PostHog", url: "https://mcp.posthog.com/mcp", description: "Query analytics, feature flags and errors in PostHog.", auth: "oauth", logo: `${CN_ICON}/posthog.svg`, color: "#f54e00", developer: "PostHog", developerUrl: "https://posthog.com", docsUrl: "https://posthog.com/docs/model-context-protocol", longDescription: "Connect PostHog so the agent can run product analytics queries, inspect insights and dashboards, manage feature flags and experiments, and investigate error tracking issues.", category: "Datos", type: "web", popularity: 45, addedAt: "2025-07-08" },
  { name: "Granola", url: "https://mcp.granola.ai/mcp", description: "Search your meeting notes and transcripts.", auth: "oauth", logo: `${CN_ICON}/granola.svg`, color: "#2c3a1a", developer: "Granola", developerUrl: "https://www.granola.ai", docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp", longDescription: "Connect Granola so the agent can search and read your meeting notes and transcripts. Pull decisions and action items from past calls into whatever you're working on.", category: "Productividad", type: "web", popularity: 44, trending: true, addedAt: "2026-03-04" },
  { name: "Prisma", url: "https://mcp.prisma.io/mcp", description: "Provision and manage Prisma Postgres databases.", auth: "oauth", logo: `${CN_ICON}/prisma.svg`, color: "#2d3748", developer: "Prisma", developerUrl: "https://www.prisma.io", docsUrl: "https://www.prisma.io/docs/ai/tools/mcp-server", longDescription: "Connect Prisma so the agent can create Prisma Postgres databases, manage backups and connection strings, and run queries in your workspace. Spin up a database for a new project in one sentence.", category: "Bases de datos", type: "web", popularity: 42, addedAt: "2025-08-12" },
  { name: "AWS Knowledge", url: "https://knowledge-mcp.global.api.aws", description: "Search AWS documentation, guidance and regional availability.", auth: "none", logo: `${CN_ICON}/aws.svg`, color: "#ff9900", developer: "Amazon Web Services", developerUrl: "https://aws.amazon.com", docsUrl: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server", longDescription: "Connect AWS Knowledge so the agent can search and read the latest AWS documentation, API references, best-practice guidance and which services are available in each region. No AWS account needed.", category: "Código", type: "web", popularity: 41, addedAt: "2025-07-16" },
  { name: "Cloudflare Observability", url: "https://observability.mcp.cloudflare.com/mcp", description: "Debug Workers with Cloudflare logs and analytics.", auth: "oauth", logo: `${CN_ICON}/cloudflare-color.svg`, color: "#f38020", developer: "Cloudflare", developerUrl: "https://www.cloudflare.com", docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", longDescription: "Connect Cloudflare Observability so the agent can query your Workers' logs and analytics to find errors, slow requests and the cause of an incident. Read-only access to your account's telemetry.", category: "Estado", type: "web", popularity: 40, addedAt: "2025-05-01" },
  { name: "Cloudflare Bindings", url: "https://bindings.mcp.cloudflare.com/mcp", description: "Build on Workers with KV, R2, D1 and Hyperdrive.", auth: "oauth", logo: `${CN_ICON}/cloudflare-color.svg`, color: "#f38020", developer: "Cloudflare", developerUrl: "https://www.cloudflare.com", docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", longDescription: "Connect Cloudflare Bindings so the agent can list and manage your Workers, KV namespaces, R2 buckets, D1 databases and Hyperdrive configs. Useful when building or debugging an app on the Cloudflare developer platform.", category: "Código", type: "web", popularity: 38, addedAt: "2025-05-01" },
  { name: "Sanity", url: "https://mcp.sanity.io", description: "Query and edit content in your Sanity projects.", auth: "oauth", logo: `${CN_ICON}/sanity.svg`, color: "#f03e2f", developer: "Sanity", developerUrl: "https://www.sanity.io", docsUrl: "https://www.sanity.io/docs/ai/mcp-server", longDescription: "Connect Sanity so the agent can query documents with GROQ, create and patch content, work with releases and inspect your schema. Manage structured content from the chat.", category: "Código", type: "web", popularity: 36, addedAt: "2025-09-09" },
  { name: "Jam", url: "https://mcp.jam.dev/mcp", description: "Debug bug reports with Jam's logs, network and replays.", auth: "oauth", logo: `${CN_ICON}/jam.svg`, color: "#ff4063", developer: "Jam", developerUrl: "https://jam.dev", docsUrl: "https://jam.dev/docs/jam-mcp", longDescription: "Connect Jam so the agent can open a bug report and read its console logs, network requests, user events and screen recording. Go from a Jam link to a fix without reproducing the bug by hand.", category: "Código", type: "web", popularity: 34, addedAt: "2025-06-12" },
  { name: "Ramp", url: "https://mcp.ramp.com/mcp", description: "Analyze spend, cards and bills in Ramp.", auth: "oauth", logo: `${CN_ICON}/ramp.svg`, color: "#e4f222", developer: "Ramp", developerUrl: "https://ramp.com", docsUrl: "https://docs.ramp.com/developer-api/v1/guides/ramp-mcp-remote", longDescription: "Connect Ramp so the agent can analyze company spend, transactions, cards, bills and reimbursements. Answer finance questions and spot trends without building reports.", category: "Servicios financieros", type: "web", popularity: 33, addedAt: "2026-04-14" },
];

const STORAGE_KEY = "optimicer.mcp.v1";

export function loadMcpServers(): McpServer[] {
  try {
    const raw = localStorage.getItem(accountKey(STORAGE_KEY));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServer[]) : [];
  } catch {
    return [];
  }
}

export function saveMcpServers(servers: McpServer[]): void {
  localStorage.setItem(accountKey(STORAGE_KEY), JSON.stringify(servers));
  clearMcpToolsCache();
}

interface McpServerConfigLike {
  type?: string;
  command?: string;
  args?: unknown[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  enabled?: boolean;
}

export function isStdioServer(server: McpServer): boolean {
  return server.transport === "stdio" || (!server.url?.trim() && !!server.command?.trim());
}

export function isMcpServerConfigured(server: McpServer): boolean {
  return isStdioServer(server) ? !!server.command?.trim() : !!server.url?.trim();
}

export function mcpServerTarget(server: McpServer): string {
  return isStdioServer(server) ? [server.command ?? "", ...(server.args ?? [])].join(" ").trim() : server.url;
}

export function configToServer(source: string, name: string, cfg: McpServerConfigLike): McpServer | null {
  const base = { id: `file:${source}:${name}`, name, source, enabled: cfg.enabled !== false };
  if (cfg.type === "stdio" || (cfg.command && !cfg.url)) {
    if (!cfg.command?.trim()) return null;
    return {
      ...base,
      url: "",
      transport: "stdio",
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env,
      cwd: cfg.cwd,
    };
  }
  return {
    ...base,
    url: String(cfg.url ?? ""),
    transport: "http",
    headers: cfg.headers,
    oauthClientId: cfg.oauthClientId,
  };
}

/** The MCP servers of the settings, the plugins and the app. Of `workspace`'s settings when given
 *  (a turn's own folder, which may not be the one open in the app; load it first with
 *  settingsFor), else of the open folder's, as Settings shows them. */
export function loadMergedMcpServers(workspace?: string | null): McpServer[] {
  const snap = workspace === undefined ? getPerSourceSnapshot() : settingsSnapshotFor(workspace).perSource;
  const byName = new Map<string, McpServer>();
  for (const source of SOURCE_PRECEDENCE) {
    const rec = (snap[source]?.mcpServers ?? {}) as Record<string, McpServerConfigLike>;
    for (const [name, cfg] of Object.entries(rec)) {
      const server = configToServer(source, name, cfg);
      if (server) byName.set(name, server);
    }
  }
  const pluginServers = getCachedPluginComponents().mcpServers;
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const server = configToServer("plugin", name, cfg as McpServerConfigLike);
    if (server) byName.set(name, server);
  }
  for (const server of loadMcpServers()) byName.set(server.name, server);
  return [...byName.values()];
}

export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

export function parseEnvLines(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

export function parseMcpToolName(full: string): { server: string; tool: string } | null {
  const parts = full.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

type FetchImpl = typeof fetch;

export type InvokeImpl = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface McpDeps {
  fetchImpl?: FetchImpl;
  invokeImpl?: InvokeImpl;
  toolImages?: boolean;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  /** `ask` shows the confirmations a server asks for before acting (see mcpElicitation.ts). */
  callTool(name: string, args: unknown, ask?: McpApprovalAsk): Promise<unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_VERSION = "0.1.0";

const INITIALIZE_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "Nyxs", version: CLIENT_VERSION },
};

/** How many times one call may come back asking for confirmation before Nyxs gives up. */
const MAX_CONFIRMATION_ROUNDS = 3;

export const MCP_TIMEOUTS = { initialize: 60_000, list: 30_000, call: 300_000 };

const HOST_ERROR_PREFIX = /^(NOT_RUNNING|EXITED|TIMEOUT): /;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hostError(e: unknown): Error {
  return new Error(errorText(e).replace(HOST_ERROR_PREFIX, ""));
}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(label));
    }, ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

async function collectTools(fetchPage: (cursor?: string) => Promise<unknown>): Promise<McpToolDef[]> {
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = (await fetchPage(cursor)) as { tools?: McpToolDef[]; nextCursor?: string } | undefined;
    tools.push(...(result?.tools ?? []));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

const SESSION_EXPIRED = Symbol("mcp-session-expired");

interface RpcOptions {
  notification?: boolean;
  timeoutMs?: number;
  retried?: boolean;
}

/** Where an OAuth connector's access token comes from, and how a rejected one is renewed. */
interface McpHttpAuth {
  token: () => Promise<string | null>;
  renew: () => Promise<string | null>;
}

class McpHttpClient implements McpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchImpl;
  private readonly auth: McpHttpAuth | undefined;
  private readonly serverName: string;
  /** Google Workspace's stateless servers: they're told on each tools call that Nyxs can show
   *  their confirmations, in the protocol they speak. Other servers get what they always got. */
  private readonly workspace: boolean;

  constructor(url: string, headers: Record<string, string>, fetchImpl: FetchImpl, auth?: McpHttpAuth, serverName = "") {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.auth = auth;
    this.serverName = serverName;
    this.workspace = isGoogleWorkspaceMcp(url);
  }

  /** `params` with the confirmation support a Workspace server needs to see. */
  private withMeta(params: Record<string, unknown>): Record<string, unknown> {
    return this.workspace ? { ...params, _meta: workspaceMcpMeta(CLIENT_VERSION) } : params;
  }

  private async send(method: string, params: unknown, notification: boolean, signal: AbortSignal, mayRenew = true): Promise<unknown> {
    const id = this.nextId++;
    const hadSession = this.sessionId !== undefined;
    const body = notification
      ? { jsonrpc: "2.0" as const, method, ...(params !== undefined ? { params } : {}) }
      : { jsonrpc: "2.0" as const, id, method, ...(params !== undefined ? { params } : {}) };

    const token = this.auth ? await this.auth.token() : null;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.workspace && method.startsWith("tools/") ? workspaceHeaders(method, params) : {}),
        ...this.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    // The access token expired or was revoked: renewed once, and the request goes again.
    if (res.status === 401 && this.auth && mayRenew && (await this.auth.renew())) {
      return this.send(method, params, notification, signal, false);
    }

    const sid = res.headers.get("Mcp-Session-Id") ?? res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (notification) return undefined;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const expired = res.status === 404 || (res.status === 400 && /session/i.test(detail));
      if (hadSession && expired && method !== "initialize") return SESSION_EXPIRED;
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const message = contentType.includes("text/event-stream")
      ? parseSseForId(await res.text(), id)
      : ((await res.json()) as JsonRpcMessage);

    if (!message) throw new Error("no JSON-RPC response from server");
    if (message.error) throw new Error(`${message.error.message} (code ${message.error.code})`);
    return message.result;
  }

  private async rpc(method: string, params: unknown, opts: RpcOptions = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? MCP_TIMEOUTS.list;
    const controller = new AbortController();
    const outcome = await withTimeout(
      this.send(method, params, !!opts.notification, controller.signal),
      timeoutMs,
      `MCP request "${method}" timed out after ${timeoutMs} ms`,
      () => controller.abort(),
    );
    if (outcome !== SESSION_EXPIRED) return outcome;
    if (opts.retried) throw new Error("the MCP session expired and could not be renewed");
    this.sessionId = undefined;
    await this.initialize();
    return this.rpc(method, params, { ...opts, retried: true });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", INITIALIZE_PARAMS, { timeoutMs: MCP_TIMEOUTS.initialize });
    await this.rpc("notifications/initialized", undefined, { notification: true });
  }

  listTools(): Promise<McpToolDef[]> {
    return collectTools((cursor) => this.rpc("tools/list", this.withMeta(cursor ? { cursor } : {}), { timeoutMs: MCP_TIMEOUTS.list }));
  }

  /** A call that needs the user's approval comes back asking; it's asked in the chat and the
   *  same call goes again with the answer and the server's state, unchanged. */
  async callTool(name: string, args: unknown, ask?: McpApprovalAsk): Promise<unknown> {
    let retry: Record<string, unknown> = {};
    for (let round = 0; round <= MAX_CONFIRMATION_ROUNDS; round++) {
      const result = await this.rpc("tools/call", this.withMeta({ name, arguments: args ?? {}, ...retry }), { timeoutMs: MCP_TIMEOUTS.call });
      if (!isInputRequired(result)) return result;
      const inputResponses = await answerInputRequests(result.inputRequests, ask, { server: this.serverName, tool: name });
      retry = { requestState: result.requestState, inputResponses };
    }
    throw new Error(`${this.serverName || "The MCP server"} kept asking for confirmation`);
  }
}

function parseSseForId(text: string, id: number): JsonRpcMessage | null {
  const messages: JsonRpcMessage[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      continue;
    }
  }
  return messages.find((m) => m.id === id) ?? messages.find((m) => m.result !== undefined || m.error) ?? null;
}

class McpStdioClient implements McpClient {
  private readonly server: McpServer;
  private readonly invokeImpl: InvokeImpl;

  constructor(server: McpServer, invokeImpl: InvokeImpl) {
    this.server = server;
    this.invokeImpl = invokeImpl;
  }

  async initialize(): Promise<void> {
    const config = {
      command: this.server.command ?? "",
      args: this.server.args ?? [],
      env: this.server.env ?? {},
      cwd: this.server.cwd?.trim() ? this.server.cwd : null,
    };
    try {
      await this.invokeImpl("mcp_stdio_start", { id: this.server.id, config, timeoutMs: MCP_TIMEOUTS.initialize });
    } catch (e) {
      throw hostError(e);
    }
  }

  private async request(method: string, params: unknown, timeoutMs: number, retried = false): Promise<unknown> {
    try {
      return await this.invokeImpl("mcp_stdio_request", { id: this.server.id, method, params, timeoutMs });
    } catch (e) {
      if (retried || !errorText(e).startsWith("NOT_RUNNING")) throw hostError(e);
      await this.initialize();
      return this.request(method, params, timeoutMs, true);
    }
  }

  listTools(): Promise<McpToolDef[]> {
    return collectTools((cursor) => this.request("tools/list", cursor ? { cursor } : {}, MCP_TIMEOUTS.list));
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, MCP_TIMEOUTS.call);
  }
}

export function createMcpClient(server: McpServer, deps: McpDeps = {}): McpClient {
  if (isStdioServer(server)) {
    return new McpStdioClient(server, deps.invokeImpl ?? invoke);
  }
  const auth = server.oauth ? { token: () => connectorAccessToken(server.id), renew: () => renewConnectorToken(server.id) } : undefined;
  return new McpHttpClient(server.url, server.headers ?? {}, deps.fetchImpl ?? fetch, auth, server.name);
}

export async function stopMcpServer(server: McpServer, deps: McpDeps = {}): Promise<void> {
  if (!isStdioServer(server)) return;
  await (deps.invokeImpl ?? invoke)<boolean>("mcp_stdio_stop", { id: server.id }).catch(() => false);
}

export interface McpImage {
  data: string;
  mediaType: string;
}

export interface McpToolOutput {
  text: string;
  images: McpImage[];
  isError: boolean;
}

export interface McpContentOutput {
  __mcpContent: true;
  text: string;
  images: McpImage[];
}

const MAX_MCP_OUTPUT = 30_000;

const MAX_MCP_IMAGE_BASE64 = 7_000_000;

function approxKb(base64: unknown): number {
  return typeof base64 === "string" ? Math.round((base64.length * 3) / 4 / 1024) : 0;
}

function resourceText(resource: unknown, images: McpImage[]): string {
  const res = (resource ?? {}) as { uri?: string; mimeType?: string; text?: string; blob?: string };
  const uri = res.uri ?? "resource";
  if (typeof res.text === "string") return `[resource ${uri}]\n${res.text}`;
  if (typeof res.blob === "string" && res.mimeType?.startsWith("image/")) {
    images.push({ data: res.blob, mediaType: res.mimeType });
    return `[resource ${uri}: image attached]`;
  }
  return `[resource ${uri}${res.mimeType ? ` (${res.mimeType})` : ""}]`;
}

export function convertMcpResult(result: unknown): McpToolOutput {
  const r = result as
    | { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean }
    | undefined;
  if (!r) return { text: "(no result)", images: [], isError: false };
  const texts: string[] = [];
  const images: McpImage[] = [];
  if (Array.isArray(r.content)) {
    for (const part of r.content) {
      const kind = String(part.type);
      if (kind === "text") {
        texts.push(String(part.text ?? ""));
      } else if (kind === "image" && typeof part.data === "string") {
        images.push({ data: part.data, mediaType: String(part.mimeType ?? "image/png") });
      } else if (kind === "audio") {
        texts.push(`[audio content: ${String(part.mimeType ?? "audio")}, ${approxKb(part.data)} KB]`);
      } else if (kind === "resource") {
        texts.push(resourceText(part.resource, images));
      } else if (kind === "resource_link") {
        texts.push(`[resource link: ${String(part.name ?? part.uri ?? "")} ${String(part.uri ?? "")}]`);
      } else {
        texts.push(`[${kind} content]`);
      }
    }
  } else if (r.structuredContent !== undefined) {
    texts.push(JSON.stringify(r.structuredContent, null, 2));
  } else {
    texts.push(JSON.stringify(r));
  }
  return { text: texts.filter(Boolean).join("\n"), images, isError: !!r.isError };
}

function imageNote(image: McpImage, reason: string): string {
  return `[image: ${image.mediaType}, ${approxKb(image.data)} KB — ${reason}]`;
}

export function formatMcpOutput(out: McpToolOutput, toolImages: boolean): string | McpContentOutput {
  const sendable = toolImages ? out.images.filter((img) => img.data.length <= MAX_MCP_IMAGE_BASE64) : [];
  const notes = out.images
    .filter((img) => !sendable.includes(img))
    .map((img) => imageNote(img, toolImages ? "too large to attach" : "the current model can't view images"));
  let text = [out.text, ...notes].filter(Boolean).join("\n");
  if (!text && sendable.length === 0) text = "(empty result)";
  if (out.isError) text = `Tool reported an error:\n${text}`;
  if (text.length > MAX_MCP_OUTPUT) {
    text = text.slice(0, MAX_MCP_OUTPUT) + `\n… [output truncated to ${MAX_MCP_OUTPUT} characters]`;
  }
  return sendable.length > 0 ? { __mcpContent: true, text, images: sendable } : text;
}

function isMcpContent(output: unknown): output is McpContentOutput {
  return !!output && typeof output === "object" && "__mcpContent" in output;
}

export function mcpToolModelOutput(output: unknown) {
  if (!isMcpContent(output)) return { type: "text" as const, value: String(output) };
  return {
    type: "content" as const,
    value: [
      ...(output.text ? [{ type: "text" as const, text: output.text }] : []),
      ...output.images.map((img) => ({ type: "image-data" as const, data: img.data, mediaType: img.mediaType })),
    ],
  };
}

export type McpServerState = "connecting" | "connected" | "error";

export interface McpServerStatus {
  state: McpServerState;
  toolCount: number;
  error?: string;
  at: number;
}

let statusSnapshot: Record<string, McpServerStatus> = {};
const statusListeners = new Set<() => void>();

function setMcpStatus(id: string, status: McpServerStatus): void {
  statusSnapshot = { ...statusSnapshot, [id]: status };
  for (const listener of statusListeners) listener();
}

export function getMcpStatuses(): Record<string, McpServerStatus> {
  return statusSnapshot;
}

export function subscribeMcpStatuses(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

const MCP_TOOLS_TTL_MS = 60_000;

interface McpCacheEntry {
  at: number;
  tools: ToolSet;
  error?: string;
}

const mcpToolsCache = new Map<string, McpCacheEntry>();

function mcpCacheKey(server: McpServer, deps: McpDeps): string {
  return JSON.stringify([
    server.id,
    server.name,
    server.url,
    server.headers ?? {},
    server.command ?? "",
    server.args ?? [],
    server.env ?? {},
    server.cwd ?? "",
    !!deps.toolImages,
  ]);
}

export function clearMcpToolsCache(): void {
  mcpToolsCache.clear();
}

/** Same measure as turnSupport's toolSchemaChars, kept local so mcp.ts doesn't pull the tool
 *  catalog into its import graph (toolDetail.ts already imports this module). */
function schemaChars(tools: ToolSet): number {
  let n = 0;
  for (const [name, def] of Object.entries(tools)) {
    const d = def as { description?: string; inputSchema?: unknown };
    n += name.length + (d.description?.length ?? 0);
    try {
      const schema = d.inputSchema as { jsonSchema?: unknown } | undefined;
      n += JSON.stringify(schema?.jsonSchema ?? schema ?? {}).length;
    } catch {
      n += 200;
    }
  }
  return n;
}

export interface CachedMcpTool {
  /** The tool's full model name (`mcp__server__tool`). */
  id: string;
  /** Server and tool as the user sees them. */
  server: string;
  name: string;
  chars: number;
}

/** Every MCP tool read last, with its own schema size, for the context panel's per-tool rows.
 *  Reads only the cache: opening the panel never connects to a server. */
export function cachedMcpTools(servers: McpServer[], toolImages: boolean): CachedMcpTool[] {
  const out: CachedMcpTool[] = [];
  for (const server of servers) {
    const cached = mcpToolsCache.get(mcpCacheKey(server, { toolImages }));
    if (!cached) continue;
    for (const [id, def] of Object.entries(cached.tools)) {
      out.push({
        id,
        server: server.name,
        name: parseMcpToolName(id)?.tool ?? id,
        chars: schemaChars({ [id]: def }),
      });
    }
  }
  return out;
}

function buildMcpTool(server: McpServer, def: McpToolDef, client: McpClient, toolImages: boolean) {
  const call = async (args: unknown, ask?: McpApprovalAsk) => formatMcpOutput(convertMcpResult(await client.callTool(def.name, args, ask)), toolImages);
  const tool = dynamicTool({
    description: def.description ?? `Tool "${def.name}" from MCP server "${server.name}".`,
    inputSchema: jsonSchema(def.inputSchema ?? { type: "object", properties: {} }),
    // Without a turn to ask in (withMcpApproval), a confirmation is declined.
    execute: (args: unknown) => call(args),
    toModelOutput: ({ output }) => mcpToolModelOutput(output),
  });
  return Object.assign(tool, { [MCP_CALL]: call });
}

export async function loadMcpTools(
  servers: McpServer[],
  deps: McpDeps = {},
): Promise<{ tools: ToolSet; errors: string[] }> {
  const tools: ToolSet = {};
  const errors: string[] = [];

  await Promise.all(
    servers.map(async (server) => {
      const cacheKey = mcpCacheKey(server, deps);
      const cached = mcpToolsCache.get(cacheKey);
      if (cached && Date.now() - cached.at < MCP_TOOLS_TTL_MS) {
        Object.assign(tools, cached.tools);
        if (cached.error) errors.push(cached.error);
        return;
      }
      if (statusSnapshot[server.id]?.state !== "connected") {
        setMcpStatus(server.id, { state: "connecting", toolCount: 0, at: Date.now() });
      }
      const serverTools: ToolSet = {};
      try {
        const client = createMcpClient(server, deps);
        await client.initialize();
        const defs = await client.listTools();
        for (const def of defs) {
          serverTools[mcpToolName(server.name, def.name)] = buildMcpTool(server, def, client, !!deps.toolImages);
        }
        Object.assign(tools, serverTools);
        mcpToolsCache.set(cacheKey, { at: Date.now(), tools: serverTools });
        setMcpStatus(server.id, { state: "connected", toolCount: defs.length, at: Date.now() });
      } catch (e) {
        const reason = errorText(e);
        const message = `${server.name}: ${reason}`;
        errors.push(message);
        mcpToolsCache.set(cacheKey, { at: Date.now(), tools: {}, error: message });
        setMcpStatus(server.id, { state: "error", toolCount: 0, error: reason, at: Date.now() });
      }
    }),
  );

  return { tools, errors };
}

export async function probeMcpServers(servers: McpServer[], deps: McpDeps = {}, force = false): Promise<void> {
  if (force) clearMcpToolsCache();
  await loadMcpTools(
    servers.filter((s) => s.enabled && isMcpServerConfigured(s)),
    deps,
  );
}
