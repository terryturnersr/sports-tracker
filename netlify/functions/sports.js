const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ESPN API endpoints
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const TEAM_IDS = {
  'indiana-fever': { sport: 'basketball', league: 'wnba', id: '5' },
  'dallas-cowboys': { sport: 'football', league: 'nfl', id: '6' },
  'houston-texans': { sport: 'football', league: 'nfl', id: '34' },
};

async function getTeamSchedule(teamKey) {
  const t = TEAM_IDS[teamKey];
  if (!t) throw new Error('Unknown team');
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
    
    const broadcasts = comp.broadcasts?.flatMap(b => b.names || []) || [];
    const venue = comp.venue?.fullName || null;
    const city = comp.venue?.address?.city || '';
    const state = comp.venue?.address?.state || '';
    const venueDisplay = venue ? (city ? `${venue}, ${city}${state ? ', '+state : ''}` : venue) : null;
    
    const game = {
      date: event.date,
      homeTeam: home.team?.displayName,
      awayTeam: away.team?.displayName,
      broadcasts,
      venue: venueDisplay,
    };
    
    const status = event.competitions?.[0]?.status?.type?.state;
    if (status === 'post') {
      game.homeScore = parseInt(home.score || 0);
      game.awayScore = parseInt(away.score || 0);
      
      // track record for our team
      const ourComp = comp.competitors?.find(c => c.team?.id === String(t.id));
      if (ourComp?.records?.[0]) {
        const rec = ourComp.records[0].summary?.split('-');
        if (rec) { wins = parseInt(rec[0]); losses = parseInt(rec[1]); }
      }
    }
    games.push(game);
  }
  
  return { games, record: { wins, losses } };
}

async function getIndyCar() {
  const year = new Date().getFullYear();
  const url = `${ESPN_BASE}/racing/indycar/scoreboard?dates=${year}`;
  
  try {
    const data = await fetchJSON(url);
    const races = [];
    
    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      const broadcasts = comp?.broadcasts?.flatMap(b => b.names || []) || [];
      const venue = comp?.venue?.fullName || null;
      const status = comp?.status?.type?.state;
      
      const race = {
        name: event.shortName || event.name,
        date: event.date,
        broadcast: broadcasts[0] || null,
        venue,
        results: null,
      };
      
      if (status === 'post') {
        const competitors = comp?.competitors || [];
        const sorted = competitors.sort((a,b) => parseInt(a.order||99) - parseInt(b.order||99));
        race.results = sorted.slice(0,3).map(c => c.athlete?.displayName || c.team?.displayName).filter(Boolean);
      }
      
      races.push(race);
    }
    
    return { races };
  } catch(e) {
    // Fallback: try motorsport endpoint
    const url2 = `https://site.api.espn.com/apis/site/v2/sports/racing/indycar/scoreboard`;
    const data2 = await fetchJSON(url2);
    const races = (data2.events || []).map(event => {
      const comp = event.competitions?.[0];
      const broadcasts = comp?.broadcasts?.flatMap(b => b.names || []) || [];
      const status = comp?.status?.type?.state;
      const race = {
        name: event.shortName || event.name,
        date: event.date,
        broadcast: broadcasts[0] || null,
        venue: comp?.venue?.fullName || null,
        results: null,
      };
      if (status === 'post') {
        const sorted = (comp?.competitors || []).sort((a,b) => parseInt(a.order||99)-parseInt(b.order||99));
        race.results = sorted.slice(0,3).map(c => c.athlete?.displayName).filter(Boolean);
      }
      return race;
    });
    return { races };
  }
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
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
