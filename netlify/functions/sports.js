const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const TEAM_IDS = {
  'indiana-fever':  { sport: 'basketball', league: 'wnba', id: '5',  name: 'Indiana Fever' },
  'dallas-cowboys': { sport: 'football',   league: 'nfl',  id: '6',  name: 'Dallas Cowboys' },
  'houston-texans': { sport: 'football',   league: 'nfl',  id: '34', name: 'Houston Texans' },
};

function getBroadcasts(comp) {
  const broadcasts = [];
  for (const b of (comp.broadcasts || [])) {
    if (Array.isArray(b.names)) broadcasts.push(...b.names);
    else if (b.name) broadcasts.push(b.name);
    else if (b.media?.shortName) broadcasts.push(b.media.shortName);
  }
  return broadcasts;
}

function getVenue(comp) {
  const venue = comp.venue?.fullName || null;
  const city  = comp.venue?.address?.city || '';
  const state = comp.venue?.address?.state || '';
  if (!venue) return null;
  return city ? `${venue}, ${city}${state ? ', ' + state : ''}` : venue;
}

function parseScore(competitor) {
  const s = competitor.score;
  if (s == null) return null;
  if (typeof s === 'object') return parseInt(s.value ?? s.displayValue) || null;
  return parseInt(s) || null;
}

async function getTeamSchedule(teamKey) {
  const t = TEAM_IDS[teamKey];
  if (!t) throw new Error('Unknown team: ' + teamKey);

  const year = new Date().getFullYear();
  const data = await fetchJSON(`${ESPN_BASE}/${t.sport}/${t.league}/teams/${t.id}/schedule?season=${year}`);

  const games = [];
  let wins = 0, losses = 0;

  for (const event of (data.events || [])) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const status = comp.status?.type?.state;
    const game = {
      date:       event.date,
      homeTeam:   home.team?.displayName || home.team?.name,
      awayTeam:   away.team?.displayName || away.team?.name,
      broadcasts: getBroadcasts(comp),
      venue:      getVenue(comp),
      status,
    };

    if (status === 'post') {
      game.homeScore = parseScore(home);
      game.awayScore = parseScore(away);
      const ours = comp.competitors?.find(c => c.team?.id === String(t.id));
      game.won = ours?.winner === true;
      const recStr = ours?.record?.[0]?.displayValue || ours?.records?.[0]?.summary || '';
      if (recStr) {
        const parts = recStr.split('-');
        if (parts.length >= 2) {
          const w = parseInt(parts[0]) || 0;
          const l = parseInt(parts[1]) || 0;
          if (w + l > wins + losses) { wins = w; losses = l; }
        }
      }
    }
    games.push(game);
  }

  if (wins === 0 && losses === 0) {
    try {
      const teamData = await fetchJSON(`${ESPN_BASE}/${t.sport}/${t.league}/teams/${t.id}`);
      const rec = teamData.team?.record?.items?.[0]?.summary || '';
      if (rec) {
        const parts = rec.split('-');
        if (parts.length >= 2) { wins = parseInt(parts[0]) || 0; losses = parseInt(parts[1]) || 0; }
      }
    } catch(e) {}
  }

  return { games, record: { wins, losses } };
}

async function getIndyCar() {
  const year = new Date().getFullYear();
  // Use date range for full season - IndyCar season runs March-September
  const startDate = `${year}0301`;
  const endDate   = `${year}0930`;
  const url = `${ESPN_BASE}/racing/indycar/scoreboard?dates=${startDate}-${endDate}&limit=30`;

  let data = null;
  try { data = await fetchJSON(url); } catch(e) {}

  // Fallback: try without date range
  if (!data?.events?.length) {
    try { data = await fetchJSON(`${ESPN_BASE}/racing/indycar/scoreboard?limit=30`); } catch(e) {}
  }

  if (!data?.events?.length) return { races: [] };

  const races = [];
  for (const event of data.events) {
    const comp = event.competitions?.[0];
    const broadcasts = getBroadcasts(comp || {});
    const status = comp?.status?.type?.state;

    const race = {
      name:      event.shortName || event.name,
      date:      event.date,
      broadcast: broadcasts[0] || null,
      venue:     comp?.venue?.fullName || null,
      results:   null,
    };

    if (status === 'post') {
      const sorted = (comp.competitors || [])
        .sort((a, b) => parseInt(a.order || 99) - parseInt(b.order || 99));
      race.results = sorted.slice(0, 3)
        .map(c => c.athlete?.displayName || c.athlete?.fullName || c.team?.displayName)
        .filter(Boolean);
    }

    races.push(race);
  }

  return { races };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'max-age=60',
  };

  try {
    const { sport, team, debug } = event.queryStringParameters || {};

    if (debug === '1') {
      const year = new Date().getFullYear();
      const url = `${ESPN_BASE}/racing/indycar/scoreboard?dates=${year}0301-${year}0930&limit=30`;
      let raw = null;
      try { raw = await fetchJSON(url); } catch(e) { raw = { error: e.message }; }
      return { statusCode: 200, headers, body: JSON.stringify({ url, eventCount: raw?.events?.length, firstEvent: raw?.events?.[0] }) };
    }

    let result;
    if (sport === 'indycar') {
      result = await getIndyCar();
    } else if (team) {
      result = await getTeamSchedule(team);
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing params' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
