// core/ai/prompts.js — All prompt templates for AI features

/**
 * Simplify a URL for token-efficient prompts.
 * Strips protocol, query params, and fragments.
 */
function simplifyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 50);
  } catch {
    return (url || '').slice(0, 60);
  }
}

export const Prompts = {
  // ── Smart Grouping ──
  smartGrouping: {
    system: [
      'You are a browser tab organizer. Given a list of tabs (title + URL), categorize them into meaningful groups.',
      'Rules:',
      '- Create 3-12 groups with short, clear names (1-3 words each)',
      '- Each tab must appear in exactly one group',
      '- Group by topic/purpose, NOT by domain (e.g., "Shopping", "Research", "Social Media", "Work", "Entertainment")',
      '- Assign each group a color from: blue, red, yellow, green, pink, purple, cyan, orange',
      '- Use different colors for different groups when possible',
      '- Respond ONLY with valid JSON, no markdown fences, no explanation',
      '',
      'Response format:',
      '{"groups":[{"name":"Group Name","color":"blue","tabIndices":[0,1,5]}]}',
    ].join('\n'),

    buildUserPrompt(tabs) {
      const lines = tabs.map((t, i) => {
        const title = (t.title || 'Untitled').slice(0, 80);
        const url = simplifyUrl(t.url || t.pendingUrl || '');
        return `[${i}] ${title} | ${url}`;
      });
      return `Categorize these ${tabs.length} tabs:\n${lines.join('\n')}`;
    },
  },

  // ── Tab Summarization ──
  tabSummary: {
    system: [
      'You summarize browser tabs. Given tab titles and URLs, produce a brief 1-sentence summary of each tab\'s likely content.',
      'Keep summaries under 15 words each.',
      'Respond ONLY with valid JSON, no markdown fences, no explanation.',
      '',
      'Response format:',
      '{"summaries":[{"index":0,"summary":"Brief description of the tab content"}]}',
    ].join('\n'),

    buildUserPrompt(tabs) {
      const lines = tabs.map((t, i) => {
        const title = (t.title || 'Untitled').slice(0, 80);
        const url = simplifyUrl(t.url || t.pendingUrl || '');
        return `[${i}] ${title} | ${url}`;
      });
      return `Summarize these ${tabs.length} tabs:\n${lines.join('\n')}`;
    },
  },

  // ── Keep Awake Classification ──
  keepAwake: {
    system: [
      'You classify browser tabs as keep-awake or safe-to-sleep.',
      'Keep-awake tabs are those the user would NOT want unloaded from memory:',
      '- Real-time communication: email, chat, messaging, video calls',
      '- Active sessions: banking, shopping carts, form inputs, dashboards',
      '- Streaming/media: playing audio or video',
      '- AI tools: ChatGPT, Claude, Gemini, Codex, AI Studio, Copilot',
      '- Calendars: Google Calendar, Outlook Calendar',
      '',
      'Safe-to-sleep tabs include:',
      '- Static documentation, articles, blog posts, news',
      '- Search results, landing pages, reference material',
      '- Inactive social media feeds',
      '',
      'Return ONLY the tabs that should stay awake.',
      'Respond ONLY with valid JSON, no markdown fences, no explanation.',
      '',
      'Response format:',
      '{"keepAwake":[{"index":0,"domain":"gmail.com","reason":"Active email"}]}',
    ].join('\n'),

    buildUserPrompt(tabs) {
      const lines = tabs.map((t, i) => {
        const title = (t.title || 'Untitled').slice(0, 80);
        const url = simplifyUrl(t.url || t.pendingUrl || '');
        return `[${i}] ${title} | ${url}`;
      });
      return `Classify which of these ${tabs.length} tabs should stay awake:\n${lines.join('\n')}`;
    },
  },

  // ── Natural Language Commands ──
  nlCommand: {
    system: [
      'You interpret natural language commands about browser tabs.',
      'Parse the user\'s intent into a structured command.',
      '',
      'Available actions:',
      '- close: Close tabs matching criteria',
      '- group: Group matching tabs into a named Chrome tab group',
      '- focus: Switch to a specific tab',
      '- move: Move matching tabs to a new window',
      '- find: Search for tabs matching criteria',
      '',
      'Filter fields (all optional, combine as needed):',
      '- domain: match by website domain (e.g., "youtube.com")',
      '- titleContains: match by text in the tab title',
      '- urlContains: match by text in the URL',
      '',
      'For the "group" action, also include:',
      '- groupName: name for the new tab group',
      '- color: one of blue, red, yellow, green, pink, purple, cyan, orange',
      '',
      'Always include a human-readable "confirmation" message describing what will happen.',
      '',
      'Respond ONLY with valid JSON, no markdown fences, no explanation.',
      '',
      'Response format:',
      '{"action":"close","filter":{"domain":"youtube.com"},"confirmation":"Close 5 YouTube tabs?"}',
    ].join('\n'),

    buildUserPrompt(command, tabContext) {
      let prompt = `Command: "${command}"`;
      if (tabContext) {
        prompt += `\n\nCurrent open tabs:\n${tabContext}`;
      }
      return prompt;
    },

    /**
     * Build a compact tab context string (max ~200 entries).
     */
    buildTabContext(tabs, maxEntries = 200) {
      const subset = tabs.slice(0, maxEntries);
      return subset.map((t, i) => {
        const title = (t.title || 'Untitled').slice(0, 60);
        const domain = simplifyUrl(t.url || '').split('/')[0];
        return `[${i}] ${title} | ${domain}`;
      }).join('\n');
    },
  },
};
