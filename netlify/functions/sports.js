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
  'indiana-fever':   { sport: 'basketball', league: 'wnba', id: '5',  name: 'Indiana Fever' },
  'dallas-cowboys':  { sport: 'football',   league: 'nfl',  id: '6',  name: 'Dallas Cowboys' },
  'houston-texans':  { sport: 'football',   league: 'nfl',  id: '34', name: 'Houston Texans' },
};

async function getTeamSchedule(teamKey) {
  const t = TEAM_IDS[teamKey];
  if (!t) throw new Error('Unknown team: ' + teamKey);

  const year = new Date().getFullYear();
  const url = `${ESPN_BASE}/${t.sport}/${t.league}/teams/${t.id}/schedule?season=${year}`;
  const data = await fetchJSON(url);

  const games = [];
  let wins = 0, losses = 0;

  for (const event of (data.events || [])) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const broadcasts = [];
    for (const b of (comp.broadcasts || [])) {
      if (Array.isArray(b.names)) broadcasts.push(...b.names);
      else if (b.name) broadcasts.push(b.name);
    }

    const venue = comp.venue?.fullName || null;
    const city  = comp.venue?.address?.city || '';
    const state = comp.venue?.address?.state || '';
    const venueDisplay = venue
      ? (city ? `${venue}, ${city}${state ? ', ' + state : ''}` : venue)
      : null;

    const game = {
      date:      event.date,
      homeTeam:  home.team?.displayName || home.team?.name,
      awayTeam:  away.team?.displayName || away.team?.name,
      broadcasts,
      venue: venueDisplay,
    };

    const state2 = comp.status?.type?.state;
    if (state2 === 'post') {
      const rawHome = home.score;
      const rawAway = away.score;
      game.homeScore = rawHome !== undefined && rawHome !== null ? parseInt(rawHome) : null;
      game.awayScore = rawAway !== undefined && rawAway !== null ? parseInt(rawAway) : null;

      const ours = comp.competitors?.find(c => c.team?.id === String(t.id));
      const recStr = ours?.records?.[0]?.summary || ours?.record?.summary || '';
      if (recStr) {
        const parts = recStr.split('-');
        if (parts.length >= 2) { wins = parseInt(parts[0]); losses = parseInt(parts[1]); }
      }
    }

    games.push(game);
  }

  if (wins === 0 && losses === 0 && data.team?.record?.items?.[0]?.summary) {
    const parts = data.team.record.items[0].summary.split('-');
    if (parts.length >= 2) { wins = parseInt(parts[0]); losses = parseInt(parts[1]); }
  }

  return { games, record: { wins, losses } };
}

async function getIndyCar() {
  const urls = [
    `${ESPN_BASE}/racing/indycar/scoreboard`,
    `https://site.api.espn.com/apis/site/v2/sports/racing/indycar/scoreboard`,
  ];

  let data = null;
  for (const url of urls) {
    try { data = await fetchJSON(url); if (data?.events?.length) break; } catch(e) {}
  }
  if (!data) return { races: [] };

  const races = [];
  for (const event of (data.events || [])) {
    const comp = event.competitions?.[0];
    const broadcasts = [];
    for (const b of (comp?.broadcasts || [])) {
      if (Array.isArray(b.names)) broadcasts.push(...b.names);
      else if (b.name) broadcasts.push(b.name);
    }

    const race = {
      name:      event.shortName || event.name,
      date:      event.date,
      broadcast: broadcasts[0] || null,
      venue:     comp?.venue?.fullName || null,
      results:   null,
    };

    if (comp?.status?.type?.state === 'post') {
      const sorted = (comp.competitors || [])
        .filter(c => c.order || c.place)
        .sort((a, b) => parseInt(a.order || a.place || 99) - parseInt(b.order || b.place || 99));
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};
