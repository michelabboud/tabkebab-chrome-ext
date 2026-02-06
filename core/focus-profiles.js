// core/focus-profiles.js — Built-in focus profiles and getters

export const BUILTIN_PROFILES = [
  {
    id: 'coding', name: 'Coding', icon: '{ }', color: 'cyan',
    allowedDomains: ['github.com', 'gitlab.com', 'stackoverflow.com', 'developer.mozilla.org', 'localhost'],
    blockedDomains: [],
    blockedCategories: ['social', 'video', 'gaming', 'entertainment'],
    suggestedDuration: 50,
  },
  {
    id: 'writing', name: 'Writing', icon: 'Aa', color: 'purple',
    allowedDomains: ['docs.google.com', 'notion.so', 'grammarly.com'],
    blockedDomains: [],
    blockedCategories: ['social', 'video', 'gaming', 'news'],
    suggestedDuration: 25,
  },
  {
    id: 'research', name: 'Research', icon: '?', color: 'green',
    allowedDomains: [],
    blockedDomains: [],
    blockedCategories: ['social', 'gaming', 'entertainment'],
    suggestedDuration: 45,
  },
  {
    id: 'meeting', name: 'Meeting', icon: '>>', color: 'blue',
    allowedDomains: ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'docs.google.com'],
    blockedDomains: [],
    blockedCategories: [],
    suggestedDuration: 60,
  },
];

export function getProfileById(id) {
  return BUILTIN_PROFILES.find(p => p.id === id) || null;
}

export function getAllProfiles() {
  return [...BUILTIN_PROFILES];
}
