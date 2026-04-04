const express = require('express');
const axios = require('axios');
const cors = require('cors');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Configuration check
if (!process.env.YOUTUBE_API_KEY) console.error('❌ MISSING YOUTUBE_API_KEY');
if (!process.env.XANO_API_KEY) console.error('❌ MISSING XANO_API_KEY');
if (!process.env.GROQ_API_KEY) console.error('❌ MISSING GROQ_API_KEY');

const PORT = process.env.PORT || 5000;

// Configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const XANO_API_KEY = process.env.XANO_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const XANO_BASE_URL = 'https://x8ki-letl-twmt.n7.xano.io/api:YD4g7WYe';
const CHANNEL_ID = 'UCwTMRMFBYAoTAmhHO6s3Mag';

// Initialize the Groq AI client
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Test endpoint
app.get('/ping', (req, res) => {
    res.send('pong');
});

// Root health check endpoint for Render
app.get('/', (req, res) => {
    res.status(200).send('OK');
});

// Fetch YouTube channel stats (works with API key - no OAuth)
async function fetchYouTubeStats(channelId) {
    try {
        const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
            params: {
                part: 'statistics',
                id: channelId,
                key: YOUTUBE_API_KEY
            }
        });

        const stats = channelRes.data.items[0]?.statistics || {};

        const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                maxResults: 3,
                order: 'viewCount',
                type: 'video',
                key: YOUTUBE_API_KEY
            }
        });

        const topVideos = videosRes.data.items.map(video => ({
            id: video.id.videoId,
            title: video.snippet.title,
            thumbnail: video.snippet.thumbnails.default.url
        }));

        // NEW: Fetch recent comments for sentiment analysis
        let recentComments = [];
        try {
            const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
                params: {
                    part: 'snippet',
                    channelId: channelId,
                    maxResults: 10,
                    order: 'time',
                    key: YOUTUBE_API_KEY
                }
            });
            recentComments = commentsRes.data.items.map(c => c.snippet.topLevelComment.snippet.textDisplay);
        } catch (err) { console.log('⚠️ Could not fetch comments'); }

        return {
            channel_id: channelId,
            views: parseInt(stats.viewCount) || 0,
            subscribers: parseInt(stats.subscriberCount) || 0,
            video_count: parseInt(stats.videoCount) || 0,
            top_videos: topVideos,
            comments: recentComments,
            fetched_at: new Date().toISOString()
        };
    } catch (error) {
        console.error('⚠️ YouTube API Error:', error.response?.data || error.message);
        // Do not re-throw here, let the caller decide
        return null;
    }
}

// Sync to Xano
async function syncToXano(data) {
    if (!data) throw new Error('Cannot sync null data to Xano');
    try {
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics`;

        const payload = {
            user: 1,
            date: new Date().toISOString().split('T')[0],
            channel_id: data.channel_id || data.channelId || 'unknown',
            views: data.views || 0,
            subscribers_gained: data.subscribers || 0,
            subscribers_lost: 0,
            top_video_id: data.top_videos?.[0]?.id || '',
            top_video_title: data.top_videos?.[0]?.title || '',
            top_video_views: 0
        };

        console.log('📤 Sending to Xano:', payload);

        const response = await axios.post(xanoUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${XANO_API_KEY}`
            }
        });

        console.log('✅ Xano response:', response.data);
        return response.data;
    } catch (error) {
        console.error('❌ Xano Sync Error:', error.response?.data || error.message);
        throw error;
    }
}



// NEW: Fetch historical data from Xano (latest records)
async function getHistoricalData() {
    try {
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics?_sort=-created_at&_limit=10`;
        const response = await axios.get(xanoUrl, {
            headers: {
                'Authorization': `Bearer ${XANO_API_KEY}`
            }
        });
        return response.data;
    } catch (error) {
        console.error('❌ Xano Fetch Error:', error.response?.data || error.message);
        throw error;
    }
}

// Simple in-memory cache for YouTube API calls (10 minute TTL)
const ytCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
    const cached = ytCache.get(key);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached.data;
    return null;
}

function setCache(key, data) {
    ytCache.set(key, { data, timestamp: Date.now() });
}

// NEW: AI Analysis Endpoint
app.get('/analyze', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    try {
        // Fetch historical data from Xano (same as before)
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics?channel_id=${channelId}&_sort=-date&_limit=10`;
        const xanoRes = await axios.get(xanoUrl, {
            headers: { 'Authorization': `Bearer ${XANO_API_KEY}` }
        });
        const history = xanoRes.data;
        if (!history.length) {
            return res.json({ success: true, recommendations: "No data yet. Sync this channel first." });
        }

        // Fetch channel name & description (optional but helpful)
        let channelName = 'Unknown';
        try {
            const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                params: { part: 'snippet', id: channelId, key: YOUTUBE_API_KEY }
            });
            if (channelRes.data.items[0]) channelName = channelRes.data.items[0].snippet.title;
        } catch (err) { console.log('Could not fetch channel name'); }

        // Prepare data for AI
        const latest = history[0];
        const totalViews = history.reduce((sum, r) => sum + (r.views || 0), 0);
        const avgViews = (totalViews / history.length).toFixed(0);

        const prompt = `You are "Massive Solver", an elite YouTube growth consultant.
Channel: ${channelName} (ID: ${channelId})
Total views (tracked): ${totalViews}
Average views per video: ${avgViews}
Latest subscriber count: ${latest.subscribers_gained || 0}
Top video: ${latest.top_video_title || 'None'}

Generate a sharp, actionable growth blueprint with:
1. Performance review (2-3 sentences)
2. Three content gaps (topics the audience wants but competitors miss)
3. For each gap, a video idea (title + unique angle)
Keep it concise and under 500 words.`;

        // Call Groq
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You are a YouTube growth expert. Provide clear, bullet-point advice." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile", // Free tier, 30 req/min
            temperature: 0.5,
            max_tokens: 1024,
        });

        const recommendations = chatCompletion.choices[0]?.message?.content || "No response from AI.";

        res.json({
            success: true,
            channel_name: channelName,
            data_points_analyzed: history.length,
            recommendations: recommendations
        });
    } catch (error) {
        console.error('Groq analysis error:', error);
        res.status(500).json({ error: 'Analysis failed', details: error.message });
    }
});

// NEW: Analytics Rating endpoint (Stub for scaling)
app.post('/api/feedback', (req, res) => {
    const { rating, feedback } = req.body;
    console.log(`⭐ New AI Feedback: ${rating}/5 - ${feedback}`);
    res.json({ success: true, message: 'Thank you for your feedback!' });
});

// Original test endpoint (kept for compatibility)
app.get('/test/youtube', async (req, res) => {
    try {
        console.log('Fetching YouTube stats...');
        const youtubeData = await fetchYouTubeStats(CHANNEL_ID);

        console.log('Syncing to Xano...');
        const xanoResult = await syncToXano(youtubeData);

        res.json({
            message: 'Data synced successfully',
            youtube_data: youtubeData,
            xano_response: xanoResult
        });
    } catch (error) {
        console.error('Workflow failed:', error.message);
        res.status(500).json({
            error: 'Sync failed',
            details: error.message
        });
    }
});

// GET /api/stats – returns latest YouTube stats for the current user
app.get('/api/stats', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    try {
        // Query Xano for records matching that channel, sorted by latest
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics?channel_id=${channelId}&_sort=-created_at&_limit=1`;
        const response = await axios.get(xanoUrl, {
            headers: { 'Authorization': `Bearer ${XANO_API_KEY}` }
        });

        if (response.data && response.data.length > 0) {
            const latest = response.data[0];
            // Fetch live stats (falls back to null on quota error)
            const liveStats = await fetchYouTubeStats(channelId);
            res.json({
                views: liveStats?.views || latest.views || 0,
                subscribers: liveStats?.subscribers || 0,
                videoCount: liveStats?.video_count || 0,
                topVideo: latest.top_video_title || 'None',
                lastUpdated: latest.created_at,
                source: liveStats ? 'live' : 'history'
            });
        } else {
            // No historical data, try to fetch live stats
            const liveStats = await fetchYouTubeStats(channelId);
            if (!liveStats) return res.status(429).json({ error: 'YouTube quota exceeded and no history found' });

            res.json({
                views: liveStats.views || 0,
                subscribers: liveStats.subscribers || 0,
                videoCount: liveStats.video_count || 0,
                topVideo: null,
                lastUpdated: null,
                source: 'live'
            });
        }
    } catch (error) {
        console.error('Stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// GET /api/history – returns last 30 records for chart visualization
app.get('/api/history', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    try {
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics?channel_id=${channelId}&_sort=-created_at&_limit=30`;
        const response = await axios.get(xanoUrl, {
            headers: { 'Authorization': `Bearer ${XANO_API_KEY}` }
        });
        // Reverse to show oldest to newest for the chart
        res.json(response.data.reverse());
    } catch (error) {
        console.error('History error:', error.message);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});
// Test endpoint to see what Xano has for a channel
app.get('/test-xano', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    try {
        const url = `${XANO_BASE_URL}/youtube_analytics?channel_id=${channelId}&_sort=-created_at`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${XANO_API_KEY}` }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Xano test failed', details: error.message });
    }
});
// POST /api/sync – triggers a fresh YouTube sync
app.post('/api/sync', async (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    try {
        console.log(`Syncing channel: ${channelId}`);
        const youtubeData = await fetchYouTubeStats(channelId);
        if (!youtubeData) {
            return res.status(429).json({ error: 'YouTube quota exceeded. Try again tomorrow.' });
        }
        const xanoData = await syncToXano(youtubeData);
        res.json({ success: true, xanoData });
    } catch (error) {
        console.error('Sync error:', error.message);
        res.status(500).json({ error: 'Failed to sync data' });
    }
});

app.listen(process.env.PORT || 5000, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${process.env.PORT || 5000}`);
    console.log(`📊 Test sync: http://localhost:${process.env.PORT || 5000}/test/youtube`);
    console.log(`🧠 AI analysis: http://localhost:${process.env.PORT || 5000}/analyze`);
});
