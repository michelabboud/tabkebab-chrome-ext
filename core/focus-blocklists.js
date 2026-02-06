// core/focus-blocklists.js — Curated blocklists for Focus Mode

/**
 * Curated lists of known distracting domains by category.
 * Users can toggle entire categories on/off in Focus Mode.
 */

export const BLOCKLIST_CATEGORIES = {
  social: {
    id: 'social',
    name: 'Social Media',
    icon: '💬',
    domains: [
      'facebook.com', 'www.facebook.com', 'm.facebook.com',
      'twitter.com', 'x.com', 'mobile.twitter.com',
      'instagram.com', 'www.instagram.com',
      'tiktok.com', 'www.tiktok.com',
      'snapchat.com', 'www.snapchat.com',
      'linkedin.com', 'www.linkedin.com',
      'reddit.com', 'www.reddit.com', 'old.reddit.com',
      'tumblr.com', 'www.tumblr.com',
      'pinterest.com', 'www.pinterest.com',
      'threads.net', 'www.threads.net',
      'mastodon.social', 'bsky.app',
      'discord.com', 'discordapp.com',
    ],
  },

  video: {
    id: 'video',
    name: 'Video & Streaming',
    icon: '📺',
    domains: [
      'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
      'netflix.com', 'www.netflix.com',
      'hulu.com', 'www.hulu.com',
      'disneyplus.com', 'www.disneyplus.com',
      'primevideo.com', 'www.primevideo.com',
      'hbomax.com', 'www.hbomax.com', 'max.com',
      'twitch.tv', 'www.twitch.tv',
      'vimeo.com', 'www.vimeo.com',
      'dailymotion.com', 'www.dailymotion.com',
      'peacocktv.com', 'paramountplus.com',
      'crunchyroll.com', 'www.crunchyroll.com',
      'pluto.tv', 'tubi.tv',
    ],
  },

  gaming: {
    id: 'gaming',
    name: 'Gaming',
    icon: '🎮',
    domains: [
      'store.steampowered.com', 'steampowered.com', 'steamcommunity.com',
      'epicgames.com', 'www.epicgames.com',
      'gog.com', 'www.gog.com',
      'origin.com', 'www.origin.com',
      'battle.net', 'www.battle.net',
      'roblox.com', 'www.roblox.com',
      'minecraft.net', 'www.minecraft.net',
      'ea.com', 'www.ea.com',
      'ubisoft.com', 'www.ubisoft.com',
      'itch.io', 'www.itch.io',
      'kongregate.com', 'www.kongregate.com',
      'poki.com', 'www.poki.com',
      'crazygames.com', 'www.crazygames.com',
      'miniclip.com', 'www.miniclip.com',
      'addictinggames.com', 'www.addictinggames.com',
      'games.com', 'www.games.com',
      'y8.com', 'www.y8.com',
      'friv.com', 'www.friv.com',
      'armor games.com', 'www.armorgames.com',
      'newgrounds.com', 'www.newgrounds.com',
    ],
  },

  news: {
    id: 'news',
    name: 'News & Media',
    icon: '📰',
    domains: [
      'cnn.com', 'www.cnn.com',
      'bbc.com', 'www.bbc.com', 'bbc.co.uk',
      'foxnews.com', 'www.foxnews.com',
      'nytimes.com', 'www.nytimes.com',
      'washingtonpost.com', 'www.washingtonpost.com',
      'theguardian.com', 'www.theguardian.com',
      'reuters.com', 'www.reuters.com',
      'apnews.com', 'www.apnews.com',
      'nbcnews.com', 'www.nbcnews.com',
      'abcnews.go.com',
      'cbsnews.com', 'www.cbsnews.com',
      'msnbc.com', 'www.msnbc.com',
      'huffpost.com', 'www.huffpost.com',
      'buzzfeed.com', 'www.buzzfeed.com',
      'vice.com', 'www.vice.com',
      'vox.com', 'www.vox.com',
      'axios.com', 'www.axios.com',
      'politico.com', 'www.politico.com',
      'news.google.com',
      'news.yahoo.com',
    ],
  },

  shopping: {
    id: 'shopping',
    name: 'Shopping',
    icon: '🛒',
    domains: [
      'amazon.com', 'www.amazon.com', 'smile.amazon.com',
      'ebay.com', 'www.ebay.com',
      'walmart.com', 'www.walmart.com',
      'target.com', 'www.target.com',
      'bestbuy.com', 'www.bestbuy.com',
      'etsy.com', 'www.etsy.com',
      'aliexpress.com', 'www.aliexpress.com',
      'wish.com', 'www.wish.com',
      'shopify.com',
      'wayfair.com', 'www.wayfair.com',
      'costco.com', 'www.costco.com',
      'homedepot.com', 'www.homedepot.com',
      'lowes.com', 'www.lowes.com',
      'macys.com', 'www.macys.com',
      'nordstrom.com', 'www.nordstrom.com',
      'zappos.com', 'www.zappos.com',
      'newegg.com', 'www.newegg.com',
    ],
  },

  entertainment: {
    id: 'entertainment',
    name: 'Entertainment & Misc',
    icon: '🎭',
    domains: [
      'spotify.com', 'open.spotify.com',
      'soundcloud.com', 'www.soundcloud.com',
      'pandora.com', 'www.pandora.com',
      'imdb.com', 'www.imdb.com',
      'rottentomatoes.com', 'www.rottentomatoes.com',
      'genius.com', 'www.genius.com',
      'last.fm', 'www.last.fm',
      '9gag.com', 'www.9gag.com',
      'imgur.com', 'www.imgur.com', 'i.imgur.com',
      'giphy.com', 'www.giphy.com',
      'knowyourmeme.com',
      'boredpanda.com', 'www.boredpanda.com',
      'theonion.com', 'www.theonion.com',
      'cracked.com', 'www.cracked.com',
    ],
  },
};

/**
 * Get all domains from enabled categories.
 * @param {string[]} enabledCategories - Array of category IDs to include
 * @returns {string[]} - Flat array of all domains from enabled categories
 */
export function getBlockedDomainsFromCategories(enabledCategories) {
  const domains = new Set();
  for (const catId of enabledCategories) {
    const cat = BLOCKLIST_CATEGORIES[catId];
    if (cat) {
      for (const domain of cat.domains) {
        domains.add(domain);
      }
    }
  }
  return Array.from(domains);
}

/**
 * Check if a hostname matches any domain in the enabled categories.
 * @param {string} hostname - The hostname to check
 * @param {string[]} enabledCategories - Array of category IDs
 * @returns {{ blocked: boolean, category: string|null }}
 */
export function checkAgainstBlocklists(hostname, enabledCategories) {
  if (!hostname || !enabledCategories?.length) {
    return { blocked: false, category: null };
  }

  const normalizedHost = hostname.toLowerCase();

  for (const catId of enabledCategories) {
    const cat = BLOCKLIST_CATEGORIES[catId];
    if (!cat) continue;

    for (const domain of cat.domains) {
      if (normalizedHost === domain || normalizedHost.endsWith('.' + domain)) {
        return { blocked: true, category: cat.name };
      }
    }
  }

  return { blocked: false, category: null };
}

/**
 * Get all available category IDs.
 */
export function getAllCategoryIds() {
  return Object.keys(BLOCKLIST_CATEGORIES);
}

/**
 * Get category info by ID.
 */
export function getCategoryById(id) {
  return BLOCKLIST_CATEGORIES[id] || null;
}
