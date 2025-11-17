// script.js - fixed & optimized version (position buttons fixed)

const tiersContainer = document.getElementById('tiers');
const addTierButton = document.getElementById('add-tier');
const saveButton = document.getElementById('save');
const resetButton = document.getElementById('reset');
const filterInput = document.getElementById('filter');

// --- Position filter state (moved to top-level so applyFilters can see it) ---
let activePosFilter = "";

// --- Sleeper API Integration ---
async function fetchPlayers() {
  try {
    const resp = await fetch('https://api.sleeper.app/v1/players/nfl');
    const data = await resp.json();
    return data;
  } catch (err) {
    console.error('Error fetching players:', err);
    return {};
  }
}

// --- globals for rendering / virtualization ---
let allPlayers = []; // full player objects array
let currentDisplayArray = []; // the currently filtered array used for rendering
let displayedCount = 0; // how many from currentDisplayArray are currently in DOM
const DISPLAY_CHUNK = 100; // how many to render initially
const LOAD_MORE_CHUNK = 50; // how many to load on scroll

// Map to track Sortable instances so we can destroy before re-init
const sortableMap = new Map();

// --- Player element factory ---
function createPlayerElement(id, player) {
  const li = document.createElement('li');
  li.classList.add('player');
  li.dataset.id = id;
  const fullName = `${player.first_name || ''} ${player.last_name || ''}`.trim();
  li.dataset.name = fullName.toLowerCase();
  li.dataset.position = (player.position || '').toUpperCase();

  const infoDiv = document.createElement('div');
  infoDiv.classList.add('player-info');

  const tag = document.createElement('span');
  tag.classList.add('position-tag', `position-${li.dataset.position}`);
  tag.textContent = li.dataset.position;

  const name = document.createElement('span');
  const team = player.team || '';
  name.textContent = `${fullName}${team ? ` (${team})` : ''}`;

  const rankInput = document.createElement('input');
  rankInput.classList.add('rank-input');
  rankInput.type = 'number';
  rankInput.min = '1';
  rankInput.value = '';
  rankInput.addEventListener('change', () => handleRankInputChange(li, rankInput));

  infoDiv.appendChild(tag);
  infoDiv.appendChild(name);
  li.appendChild(infoDiv);
  li.appendChild(rankInput);
  return li;
}

// --- Sortable management (destroy if exists, then create) ---
function initSortable(list, allowPut = true) {
  if (!list) return;
  // If there is an existing Sortable instance for this element, destroy it first
  if (sortableMap.has(list)) {
    try {
      const existing = sortableMap.get(list);
      existing.destroy();
    } catch (e) {
      // ignore
    }
    sortableMap.delete(list);
  }

  const sortable = new Sortable(list, {
    group: {
      name: 'shared',
      pull: true,
      put: allowPut,
    },
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: () => {
      requestAnimationFrame(() => {
        updateRanks();
        delayedSave();
      });
    },
  });

  sortableMap.set(list, sortable);
}

// --- create a new tier and make it sortable ---
function createTier(number) {
  const tierDiv = document.createElement('div');
  tierDiv.classList.add('tier');
  tierDiv.dataset.tier = number;

  const title = document.createElement('h2');
  title.textContent = `Tier ${number}`;

  const list = document.createElement('ul');
  list.id = `tier-${number}`;
  list.classList.add('player-list');

  tierDiv.appendChild(title);
  tierDiv.appendChild(list);

  // insert before the unranked tier (keep unranked at bottom)
  const unranked = document.querySelector('[data-tier="unranked"]');
  if (unranked) tiersContainer.insertBefore(tierDiv, unranked);
  else tiersContainer.appendChild(tierDiv);

  initSortable(list, true);
}

// --- delayed save to reduce localStorage churn ---
let saveTimeout;
function delayedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveRankings, 1500);
}

// --- save / load ---
function saveRankings() {
  const tiers = {};
  document.querySelectorAll('.player-list').forEach(list => {
    const tierId = list.id;
    const players = Array.from(list.querySelectorAll('.player')).map(p => p.dataset.id);
    tiers[tierId] = players;
  });
  try {
    localStorage.setItem('rankings', JSON.stringify(tiers));
  } catch (e) {
    console.warn('Could not save rankings:', e);
  }
}

function loadRankings() {
  const saved = JSON.parse(localStorage.getItem('rankings') || '{}');
  if (!saved) return;

  for (const [tierId, playerIds] of Object.entries(saved)) {
    const list = document.getElementById(tierId);
    if (!list) continue;

    playerIds.forEach(id => {
      const player = document.querySelector(`.player[data-id="${id}"]`);
      if (player) {
        list.appendChild(player);
      } else {
        console.warn(`Player ${id} missing from Sleeper data, skipping.`);
      }
    });
  }
}

// --- reset ---
function resetRankings() {
  localStorage.removeItem('rankings');
  window.location.reload();
}

// --- ranking logic (updates rank inputs) ---
function updateRanks() {
  requestAnimationFrame(() => {
    document.querySelectorAll('.tier').forEach(tier => {
      if (tier.dataset.tier === 'unranked') return;
      const players = tier.querySelectorAll('.player');
      players.forEach((player, i) => {
        const input = player.querySelector('.rank-input');
        if (input) input.value = i + 1;
      });
    });
  });
}

function handleRankInputChange(player, input) {
  const tier = player.closest('.tier');
  if (!tier || tier.dataset.tier === 'unranked') return;

  const list = tier.querySelector('.player-list');
  const players = Array.from(list.children);
  let newRank = parseInt(input.value);
  if (isNaN(newRank) || newRank < 1) newRank = 1;
  if (newRank > players.length) newRank = players.length;
  // If target index is same as current, nothing to do
  const currentIndex = players.indexOf(player);
  if (currentIndex === newRank - 1) {
    updateRanks();
    return;
  }
  list.insertBefore(player, players[newRank - 1] || null);
  updateRanks();
  delayedSave();
}

// --- rendering helpers for virtualization / lazy load ---
function renderInitialPlayers() {
  currentDisplayArray = allPlayers.slice(); // default
  displayedCount = 0;
  renderMorePlayers(DISPLAY_CHUNK);
}

function renderMorePlayers(limit = LOAD_MORE_CHUNK) {
  const unrankedList = document.getElementById('tier-unranked');
  if (!unrankedList) return;
  const slice = currentDisplayArray.slice(displayedCount, displayedCount + limit);
  // append elements
  slice.forEach(p => {
    // ensure we don't append a duplicate element if it's already in DOM
    if (!document.querySelector(`.player[data-id="${p.id}"]`)) {
      unrankedList.appendChild(createPlayerElement(p.id, p));
    } else {
      // if already exists in DOM (e.g. from saved ranking), skip
    }
  });
  displayedCount += slice.length;
  // re-init sortable for unranked after DOM changes (allow drops)
  initSortable(unrankedList, true);
}

// --- apply filters using the in-memory array (fast) ---
// NOTE: this now filters across ALL player elements (ranked + unranked)
function applyFilters() {
  const nameSearch = (filterInput.value || '').toLowerCase();

  document.querySelectorAll('.player').forEach(p => {
    const playerName = p.dataset.name || '';
    const playerPos = (p.dataset.position || '').toUpperCase();
    const matchesName = !nameSearch || playerName.includes(nameSearch);
    const matchesPos = !activePosFilter || playerPos === activePosFilter;
    p.style.display = matchesName && matchesPos ? '' : 'none';
  });
}

// --- initialization routines ---
async function populateUnranked() {
  const playersObj = await fetchPlayers();
  allPlayers = Object.entries(playersObj)
    .map(([id, p]) => ({ id, ...p }))
    .filter(p => ['QB', 'RB', 'WR', 'TE'].includes((p.position || '').toUpperCase()))
    .sort((a, b) => {
      const la = (a.last_name || '').toLowerCase();
      const lb = (b.last_name || '').toLowerCase();
      if (la < lb) return -1;
      if (la > lb) return 1;
      return (a.first_name || '').toLowerCase().localeCompare((b.first_name || '').toLowerCase());
    });

  const unrankedList = document.getElementById('tier-unranked');

  // Option A: Render ALL players immediately (uncomment to use)
  allPlayers.forEach(p => {
    if (!document.querySelector(`.player[data-id="${p.id}"]`)) {
      unrankedList.appendChild(createPlayerElement(p.id, p));
    }
  });

  // Option B: If you'd rather use lazy-loading, comment the block above and instead:
  // renderInitialPlayers();

  // enable dragging for unranked
  initSortable(unrankedList, true);

  // load previous rankings after all players exist
  loadRankings();
  updateRanks();

  console.log(`Loaded ${allPlayers.length} players (positions filtered).`);
}

// --- event wiring and page setup (after DOM loaded) ---
document.addEventListener('DOMContentLoaded', () => {
  // init Sortable on any pre-existing tier lists (Tier 1 if present, etc.)
  document.querySelectorAll('.player-list').forEach(list => {
    initSortable(list, true);
  });

  // wire Add Tier
  addTierButton.addEventListener('click', () => {
    const existingTiers = Array.from(document.querySelectorAll('.tier'))
      .map(t => t.dataset.tier)
      .filter(t => t !== 'unranked')
      .map(Number);
    const newTierNumber = existingTiers.length ? Math.max(...existingTiers) + 1 : 1;
    createTier(newTierNumber);
    delayedSave();
  });

  // wire save/reset
  saveButton.addEventListener('click', saveRankings);
  resetButton.addEventListener('click', resetRankings);

  // filter listeners (debounced)
  let filterTimeout;
  filterInput.addEventListener('input', () => {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(applyFilters, 150);
  });

  // Position buttons (must exist in HTML with id #position-buttons and .pos-btn)
  const posBtns = document.querySelectorAll('#position-buttons .pos-btn');
  if (posBtns && posBtns.length) {
    posBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        // Update active button styling
        posBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Set filter and reapply
        activePosFilter = btn.dataset.pos || '';
        // normalize to uppercase empty or position
        activePosFilter = activePosFilter ? activePosFilter.toUpperCase() : '';
        applyFilters();
      });
    });
  }

  // attach scroll listener for unranked (lazy loading) after element exists
  const unrankedListEl = document.getElementById('tier-unranked');
  if (unrankedListEl) {
    unrankedListEl.addEventListener('scroll', () => {
      if (unrankedListEl.scrollTop + unrankedListEl.clientHeight >= unrankedListEl.scrollHeight - 40) {
        renderMorePlayers(LOAD_MORE_CHUNK);
      }
    });
  }

  // finally, populate players
  populateUnranked();
});
