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
    else if (b.market?.type === 'National' && b.media?.shortName) broadcasts.push(b.media.shortName);
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

function parseEvent(event, teamId) {
  const comp = event.competitions?.[0];
  if (!comp) return null;

  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const status = comp.status?.type?.state;
  const game = {
    date:     event.date,
    homeTeam: home.team?.displayName || home.team?.name,
    awayTeam: away.team?.displayName || away.team?.name,
    broadcasts: getBroadcasts(comp),
    venue: getVenue(comp),
    status,
  };

  if (status === 'post') {
    const hs = home.score;
    const as = away.score;
    game.homeScore = (hs !== null && hs !== undefined && hs !== '') ? parseInt(hs) : null;
    game.awayScore = (as !== null && as !== undefined && as !== '') ? parseInt(as) : null;

    const ours = comp.competitors?.find(c => c.team?.id === String(teamId));
    const recStr = ours?.records?.[0]?.summary || '';
    if (recStr) {
      const parts = recStr.split('-');
      if (parts.length >= 2) return { game, wins: parseInt(parts[0]) || 0, losses: parseInt(parts[1]) || 0 };
    }
  }

  return { game, wins: 0, losses: 0 };
}

async function getTeamSchedule(teamKey) {
  const t = TEAM_IDS[teamKey];
  if (!t) throw new Error('Unknown team: ' + teamKey);

  const year = new Date().getFullYear();
  const schedUrl = `${ESPN_BASE}/${t.sport}/${t.league}/teams/${t.id}/schedule?season=${year}`;
  const data = await fetchJSON(schedUrl);

  const games = [];
  let wins = 0, losses = 0;

  for (const event of (data.events || [])) {
    const result = parseEvent(event, t.id);
    if (!result) continue;
    games.push(result.game);
    if (result.wins > wins || result.losses > losses) {
      wins = result.wins;
      losses = result.losses;
    }
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
  let data = null;
  try {
    data = await fetchJSON(`${ESPN_BASE}/racing/indycar/scoreboard`);
  } catch(e) {}

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
      const competitors = (comp.competitors || [])
        .filter(c => c.order != null || c.statistics != null)
        .sort((a, b) => parseInt(a.order || 99) - parseInt(b.order || 99));
      race.results = competitors.slice(0, 3)
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
    'Cache-Control': 'max-age=300',
  };

  try {
    const { sport, team } = event.queryStringParameters || {};
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
