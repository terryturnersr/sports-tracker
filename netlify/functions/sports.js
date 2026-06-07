const https = require('https');
const zlib = require('zlib');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip, deflate' } }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(decoded.toString())); }
            catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(decoded.toString())); }
            catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
          });
        } else {
          try { resolve(JSON.parse(buffer.toString())); }
          catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
        }
      });
      res.on('error', reject);
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
  const urls = [
    `${ESPN_BASE}/racing/indycar/scoreboard?dates=20260301-20260930&limit=30`,
    `${ESPN_BASE}/racing/indycar/scoreboard?season=2026`,
    `${ESPN_BASE}/racing/indycar/scoreboard?limit=30`,
  ];
  let data = null;
  for (const url of urls) {
    try {
      const d = await fetchJSON(url);
      if (d?.events?.length) { data = d; break; }
    } catch(e) {}
  }
  if (!data) return { races: [] };
  const races = [];
  for (const event of (data.events || [])) {
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
    const params = event.queryStringParameters || {};
    const sport = params.sport;
    const team = params.team;
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
