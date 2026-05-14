const API_BASE = 'https://api.opendota.com/api';
/** Steam CDN hosts Dota asset paths from OpenDota constants (cdn.dota2.com is often broken). */
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com';

function cdnFromApiPath(imgPath) {
  if (!imgPath || typeof imgPath !== 'string') return '';
  const path = imgPath.split('?')[0];
  if (path.startsWith('http')) return path;
  return path.startsWith('/') ? STEAM_CDN + path : `${STEAM_CDN}/${path}`;
}

let itemNames = {};
let itemImgUrl = {};  // item id -> CDN image URL
let abilityNames = {}; // ability id -> internal name
let abilityImgUrl = {}; // ability id -> CDN image URL
let abilityDname = {}; // internal name -> display name (from /constants/abilities)
let heroNames = {};
let heroesList = []; // { id, name } sorted by name, for dropdown

const itemSlots = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2'];

/** Last hero id covered by dota2-minimap-hero-sprites@2.4.0 (Dawnbreaker). Newer heroes use OpenDota `icon` as fallback. */
const MINIMAP_SPRITE_MAX_HERO_ID = 135;

/** OpenDota player matches list supports a high limit; cap to avoid huge payloads. */
const MAX_MATCH_LIMIT = 500;
/** Parallel GET /matches/{id} requests (balance speed vs HTTP 429). */
const MATCH_DETAIL_CONCURRENCY = 10;

/** One shared graphic for talent rows (special_bonus entries have no real in-game artwork). */
const TALENT_GENERIC_ICON_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0c1411" stroke="#1a2e24" stroke-width="1"/><path fill="#e8b84a" d="M16 8.5l1.6 4.9h5.2l-4.2 3 1.6 4.9-4.2-3-4.2 3 1.6-4.9-4.2-3h5.2L16 8.5z"/></svg>'
  );

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function loadConstants() {
  const [itemsRes, abilityIdsRes, abilitiesRes, heroesRes] = await Promise.all([
    fetchJson(`${API_BASE}/constants/items`),
    fetchJson(`${API_BASE}/constants/ability_ids`),
    fetchJson(`${API_BASE}/constants/abilities`),
    fetchJson(`${API_BASE}/constants/heroes`),
  ]);

  for (const [key, data] of Object.entries(itemsRes)) {
    if (data && typeof data.id !== 'undefined' && data.dname) {
      itemNames[data.id] = data.dname;
      if (data.img) {
        const url = cdnFromApiPath(data.img);
        if (url) itemImgUrl[data.id] = url;
      }
    }
  }

  for (const [idStr, name] of Object.entries(abilityIdsRes)) {
    const id = Number(idStr);
    const internalName = name || idStr;
    abilityNames[id] = internalName;
    const ab = abilitiesRes[internalName];
    const fromConstants = ab && ab.img ? cdnFromApiPath(ab.img) : '';
    abilityImgUrl[id] =
      fromConstants ||
      cdnFromApiPath(`/apps/dota2/images/dota_react/abilities/${internalName}.png`);
  }

  for (const [key, data] of Object.entries(abilitiesRes)) {
    if (data && data.dname) abilityDname[key] = data.dname;
  }

  for (const [idStr, data] of Object.entries(heroesRes)) {
    if (data && data.localized_name) {
      const id = Number(idStr);
      heroNames[id] = data.localized_name;
      const npcName = data.name || '';
      const iconUrl = data.icon ? cdnFromApiPath(data.icon) : '';
      heroesList.push({ id, name: data.localized_name, npcName, iconUrl });
    }
  }
  heroesList.sort((a, b) => a.name.localeCompare(b.name));
}

function escapeHtml(s) {
  if (s == null) return '';
  const t = String(s);
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getAbilityDisplayName(abilityId) {
  const internalName = abilityNames[abilityId];
  if (!internalName) return null;
  return abilityDname[internalName] || formatAbilityName(internalName);
}

function formatAbilityName(internalName) {
  if (!internalName) return '?';
  if (internalName.startsWith('special_bonus_')) {
    const rest = internalName.replace('special_bonus_', '');
    return rest.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const parts = internalName.split('_');
  const name = parts.slice(1).join(' ');
  return name.replace(/\b\w/g, (c) => c.toUpperCase()) || internalName;
}

function getPlayerSlotFromMatchesList(matchInList) {
  return matchInList.player_slot;
}

function findPlayerInMatch(match, playerSlot) {
  return match.players && match.players.find((p) => p.player_slot === playerSlot);
}

async function fetchMatches(accountId, limit, heroId) {
  const url = `${API_BASE}/players/${encodeURIComponent(accountId)}/matches?limit=${limit}&hero_id=${encodeURIComponent(heroId)}`;
  return fetchJson(url);
}

async function fetchMatchDetails(matchId) {
  const url = `${API_BASE}/matches/${matchId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }
  throw new Error('API error: rate limit');
}

/**
 * Load full match JSON for each list entry in parallel (small worker pool).
 */
async function loadMatchesDataParallel(matchesToFetch, onProgress) {
  const matchesData = [];
  const heroCounts = {};
  let completed = 0;
  const total = matchesToFetch.length;

  async function handleOne(m) {
    try {
      const match = await fetchMatchDetails(m.match_id);
      const playerSlot = getPlayerSlotFromMatchesList(m);
      const player = findPlayerInMatch(match, playerSlot);
      if (!player) return;
      const items = [];
      for (const slot of itemSlots) {
        const id = player[slot];
        if (id) items.push(id);
      }
      const abilityUpgrades = player.ability_upgrades_arr || [];
      matchesData.push({ items, abilityUpgrades });
      const hid = player.hero_id;
      heroCounts[hid] = (heroCounts[hid] || 0) + 1;
    } catch (_) {
      // skip failed or missing match
    } finally {
      completed++;
      onProgress(completed, total);
    }
  }

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= matchesToFetch.length) break;
      await handleOne(matchesToFetch[i]);
    }
  }

  const pool = Math.min(MATCH_DETAIL_CONCURRENCY, Math.max(1, total));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return { matchesData, heroCounts };
}

function aggregateItems(matchesData) {
  const counts = {};
  for (const { items } of matchesData) {
    for (const itemId of items) {
      if (itemId && itemId !== 0) {
        counts[itemId] = (counts[itemId] || 0) + 1;
      }
    }
  }
  return Object.entries(counts)
    .map(([id, count]) => ({ id: Number(id), count }))
    .sort((a, b) => b.count - a.count);
}

function aggregateSkillBuild(matchesData) {
  const byIndex = {};
  const maxLen = 25;
  for (const { abilityUpgrades } of matchesData) {
    if (!abilityUpgrades || !Array.isArray(abilityUpgrades)) continue;
    for (let i = 0; i < Math.min(abilityUpgrades.length, maxLen); i++) {
      const ab = abilityUpgrades[i];
      if (!ab) continue;
      const name = abilityNames[ab];
      if (name && name.startsWith('special_bonus_')) continue;
      if (!byIndex[i]) byIndex[i] = {};
      byIndex[i][ab] = (byIndex[i][ab] || 0) + 1;
    }
  }
  const build = [];
  for (let i = 0; i < maxLen; i++) {
    const votes = byIndex[i];
    if (!votes) break;
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    if (best) build.push({ level: i + 1, abilityId: best[0], count: best[1] });
  }
  return build;
}

function aggregateTalents(matchesData) {
  const bySlot = { 10: {}, 15: {}, 20: {}, 25: {} };
  const talentLevels = [10, 15, 20, 25];
  for (const { abilityUpgrades } of matchesData) {
    if (!abilityUpgrades || !Array.isArray(abilityUpgrades)) continue;
    let talentIndex = 0;
    for (let i = 0; i < abilityUpgrades.length; i++) {
      const ab = abilityUpgrades[i];
      const name = abilityNames[ab];
      if (name && name.startsWith('special_bonus_')) {
        const level = talentLevels[talentIndex];
        if (level) {
          bySlot[level][ab] = (bySlot[level][ab] || 0) + 1;
          talentIndex++;
        }
      }
    }
  }
  return bySlot;
}

function showError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function showProgress(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function renderSummary(gamesAnalyzed, heroBreakdown, selectedHeroId, opts) {
  const el = document.getElementById('summaryText');
  let html = `Analyzed <strong>${gamesAnalyzed}</strong> games`;
  if (selectedHeroId && heroNames[selectedHeroId]) {
    html += ` as <strong>${heroNames[selectedHeroId]}</strong>`;
  }
  html += '.';
  if (opts && opts.requested != null && opts.requested > gamesAnalyzed) {
    const miss = opts.requested - gamesAnalyzed;
    html += ` <span class="summary-note">${miss} match${miss === 1 ? '' : 'es'} could not be loaded (API or replay unavailable).</span>`;
  }
  if (heroBreakdown && heroBreakdown.length > 0 && !selectedHeroId) {
    const top = heroBreakdown.slice(0, 5);
    html += ' Top heroes: ' + top.map((h) => `${heroNames[h.heroId] || h.heroId} (${h.games})`).join(', ') + '.';
  }
  if (el) el.innerHTML = html;
}

function renderItems(sortedItems) {
  const container = document.getElementById('itemsList');
  if (!container) return;
  container.innerHTML = sortedItems
    .slice(0, 40)
    .map((item) => {
      const name = itemNames[item.id] || `Item ${item.id}`;
      const imgUrl = itemImgUrl[item.id];
      const img = imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="" class="item-icon" loading="lazy" />` : '';
      return `<div class="item-chip">${img}<span class="count">${item.count}</span><span>${escapeHtml(name)}</span></div>`;
    })
    .join('');
}

function renderSkillBuild(build) {
  const container = document.getElementById('skillBuildList');
  if (!container) return;
  container.innerHTML = build
    .map((s) => {
      const name = getAbilityDisplayName(s.abilityId) || `Ability ${s.abilityId}`;
      const imgUrl = abilityImgUrl[s.abilityId];
      const img = imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="" class="ability-icon" loading="lazy" />` : '';
      return `<span class="skill-level">${img}<span class="lvl">${s.level}</span><span>${escapeHtml(name)}</span></span>`;
    })
    .join('');
}

function renderTalents(bySlot) {
  const container = document.getElementById('talentsList');
  if (!container) return;
  const talentImg = `<img src="${TALENT_GENERIC_ICON_SRC}" alt="" class="talent-icon talent-icon-generic" width="28" height="28" />`;
  const rows = [10, 15, 20, 25].map((level) => {
    const votes = bySlot[level];
    if (!votes || Object.keys(votes).length === 0) {
      return `<div class="talent-row talent-row-empty">${talentImg}<span class="talent-level">${level}</span><span class="talent-name">— No data</span></div>`;
    }
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, c]) => s + c, 0);
    const [abilityId, count] = sorted[0];
    const pct = total ? Math.round((count / total) * 100) : 0;
    const aid = Number(abilityId);
    const name = getAbilityDisplayName(aid) || formatAbilityName(abilityNames[aid]) || `Talent ${abilityId}`;
    return `<div class="talent-row">${talentImg}<span class="talent-level">${level}</span><span class="talent-name">${escapeHtml(name)}</span><span class="talent-pct">${pct}% (${count}/${total})</span></div>`;
  });
  container.innerHTML = rows.join('');
}

// --- Hero dropdown ---
function buildHeroDropdownList(filter) {
  const q = (filter || '').trim().toLowerCase();
  return q ? heroesList.filter((h) => h.name.toLowerCase().includes(q)) : [...heroesList];
}

function renderHeroDropdown(filter) {
  const ul = document.getElementById('heroDropdown');
  const list = buildHeroDropdownList(filter);
  if (!ul) return;
  ul.innerHTML = list
    .map((h, i) => {
      const nameEsc = escapeHtml(h.name);
      const nameAttr = h.name.replace(/"/g, '&quot;');
      const useMinimapSprite = h.id <= MINIMAP_SPRITE_MAX_HERO_ID && h.npcName;
      const minimap = useMinimapSprite
        ? `<span class="hero-minimap-wrap" aria-hidden="true"><i class="d2mh hero-${h.id} ${h.npcName}"></i></span>`
          : h.iconUrl
            ? `<span class="hero-minimap-wrap" aria-hidden="true"><img class="hero-dropdown-minimap-fallback" src="${escapeHtml(h.iconUrl)}" alt="" width="28" height="28" loading="lazy" /></span>`
            : `<span class="hero-minimap-wrap hero-minimap-wrap--empty" aria-hidden="true"></span>`;
      return `<li class="hero-dropdown-option" role="option" data-hero-id="${h.id}" data-hero-name="${nameAttr}" aria-selected="${i === 0}">${minimap}<span class="hero-dropdown-name">${nameEsc}</span></li>`;
    })
    .join('');
  ul.hidden = list.length === 0;
  if (list.length) ul.firstElementChild?.setAttribute('aria-selected', 'true');
}

function closeHeroDropdown() {
  const ul = document.getElementById('heroDropdown');
  if (ul) ul.hidden = true;
}

function setSelectedHero(id, name) {
  const input = document.getElementById('heroId');
  const search = document.getElementById('heroSearch');
  if (input) input.value = id || '';
  if (search) {
    search.value = '';
    search.placeholder = name || 'Search or select hero…';
  }
  closeHeroDropdown();
}

function setupHeroDropdown() {
  const search = document.getElementById('heroSearch');
  const ul = document.getElementById('heroDropdown');
  if (!search || !ul) return;

  search.addEventListener('focus', () => renderHeroDropdown(search.value));
  search.addEventListener('input', () => renderHeroDropdown(search.value));
  search.addEventListener('blur', () => {
    setTimeout(closeHeroDropdown, 150);
  });

  ul.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-hero-id]');
    if (!li) return;
    const id = li.getAttribute('data-hero-id');
    const name = li.getAttribute('data-hero-name') || '';
    setSelectedHero(id, name);
  });

  ul.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHeroDropdown();
  });
}

async function runAnalysis() {
  const accountInput = document.getElementById('accountId');
  const matchLimitInput = document.getElementById('matchLimit');
  const heroIdInput = document.getElementById('heroId');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const errorEl = document.getElementById('searchError');
  const progressEl = document.getElementById('searchProgress');
  const resultsEl = document.getElementById('results');

  if (!accountInput || !analyzeBtn || !errorEl || !progressEl || !resultsEl) {
    console.error('Missing DOM elements');
    return;
  }

  const accountId = (accountInput.value || '').trim().replace(/\D/g, '');
  const rawLimit = parseInt(String(matchLimitInput?.value ?? '').trim(), 10);
  const limit = Math.min(MAX_MATCH_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
  const heroId = (heroIdInput?.value || '').trim() || null;

  showError(errorEl, '');
  resultsEl.hidden = true;

  if (!accountId) {
    showError(errorEl, 'Please enter a Steam Account ID (numbers only).');
    return;
  }
  if (!heroId) {
    showError(errorEl, 'Please select a hero to analyze.');
    return;
  }

  const originalBtnText = analyzeBtn.textContent;
  analyzeBtn.textContent = 'Analyzing…';
  analyzeBtn.disabled = true;

  try {
    showProgress(progressEl, 'Fetching your matches…');
    const matchesList = await fetchMatches(accountId, limit, heroId);
    if (!matchesList.length) {
      showProgress(progressEl, '');
      showError(errorEl, 'No matches found for this hero. Try another hero or ensure match history is public.');
      return;
    }

    const matchesToFetch = matchesList.slice(0, limit);
    showProgress(progressEl, `Loading ${matchesToFetch.length} match details…`);
    const { matchesData, heroCounts } = await loadMatchesDataParallel(matchesToFetch, (done, tot) => {
      showProgress(progressEl, `Loaded ${done} / ${tot} matches…`);
    });

    showProgress(progressEl, '');

    if (matchesData.length === 0) {
      showError(errorEl, 'Could not load match details. Some matches may be unavailable.');
      return;
    }

    const heroBreakdown = Object.entries(heroCounts)
      .map(([heroIdKey, games]) => ({ heroId: Number(heroIdKey), games }))
      .sort((a, b) => b.games - a.games);

    const sortedItems = aggregateItems(matchesData);
    const skillBuild = aggregateSkillBuild(matchesData);
    const talents = aggregateTalents(matchesData);

    renderSummary(matchesData.length, heroBreakdown, heroId ? Number(heroId) : null, {
      requested: matchesToFetch.length,
    });
    renderItems(sortedItems);
    renderSkillBuild(skillBuild);
    renderTalents(talents);

    resultsEl.hidden = false;
  } catch (err) {
    showProgress(progressEl, '');
    const msg = err && err.message ? err.message : 'Something went wrong. Try again.';
    let userMsg = msg;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg === 'Failed to fetch') {
      userMsg = 'Network error. Open this page through a local server (e.g. run "npx serve ." in this folder) so the app can load data.';
    }
    showError(errorEl, userMsg);
  } finally {
    analyzeBtn.textContent = originalBtnText;
    analyzeBtn.disabled = false;
  }
}

function init() {
  const analyzeBtn = document.getElementById('analyzeBtn');
  const accountInput = document.getElementById('accountId');
  const errorEl = document.getElementById('searchError');
  const progressEl = document.getElementById('searchProgress');

  if (!analyzeBtn) return;

  analyzeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    runAnalysis();
  });
  accountInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runAnalysis();
    }
  });
  const matchLimitInput = document.getElementById('matchLimit');
  matchLimitInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runAnalysis();
    }
  });
  matchLimitInput?.addEventListener('blur', () => {
    const v = parseInt(String(matchLimitInput.value).trim(), 10);
    if (!Number.isFinite(v)) matchLimitInput.value = '100';
    else matchLimitInput.value = String(Math.min(MAX_MATCH_LIMIT, Math.max(1, v)));
  });

  setupHeroDropdown();

  // Load constants on page load so hero dropdown is ready and first Analyze is fast
  (async () => {
    showProgress(progressEl, 'Loading heroes and data…');
    try {
      await loadConstants();
      showProgress(progressEl, '');
    } catch (err) {
      const msg = err && err.message ? err.message : '';
      let userMsg = 'Could not load app data. ';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        userMsg += 'Open this page through a local server (e.g. run "npx serve ." in this folder).';
      } else {
        userMsg += msg || 'Try refreshing.';
      }
      showError(errorEl, userMsg);
      showProgress(progressEl, '');
    }
  })();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
