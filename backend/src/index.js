const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Configuration check
if (!process.env.YOUTUBE_API_KEY) console.error('❌ MISSING YOUTUBE_API_KEY');
if (!process.env.XANO_API_KEY) console.error('❌ MISSING XANO_API_KEY');
if (!process.env.GOOGLE_API_KEY) console.error('❌ MISSING GOOGLE_API_KEY');

const PORT = process.env.PORT || 5000;

// Configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const XANO_API_KEY = process.env.XANO_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const XANO_BASE_URL = 'https://x8ki-letl-twmt.n7.xano.io/api:YD4g7WYe';
const CHANNEL_ID = 'UCwTMRMFBYAoTAmhHO6s3Mag';

// Initialize the Gemini AI client
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

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

// Gemini retry helper
async function callGeminiWithRetry(prompt, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemma-3-12b-it" });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (err) {
            // Status 503: Service Unavailable OR Status 429: Rate Limit
            if ((err.status === 503 || err.status === 429) && i < retries - 1) {
                const delay = Math.pow(2, i) * 1000;
                console.log(`⚠️ Gemini busy (status ${err.status}), retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
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
    try {
        const { channelId: queryChannelId } = req.query;
        console.log('📊 Fetching historical data from Xano...');
        const history = await getHistoricalData();
        
        if (!history || history.length === 0) {
            return res.json({
                success: true,
                message: "No data yet. Please sync a YouTube channel first.",
                recommendations: "After syncing, I'll provide a complete growth strategy."
            });
        }

        console.log(`📈 Found ${history.length} records.`);

        // Prioritize query ID, fall back to newest sync record
        const latest = history[0];
        const channelId = queryChannelId || latest.channel_id || CHANNEL_ID;
        
        console.log(`🔍 Starting enrichment for channel: ${channelId}`);
        
        // Fetch live channel info (name, description) from YouTube API (with caching)
        let channelName = 'Unknown';
        let channelDescription = '';
        const channelCacheKey = `channel_${channelId}`;
        const cachedChannel = getCached(channelCacheKey);

        if (cachedChannel) {
            console.log('♻️ Using cached channel details');
            channelName = cachedChannel.name;
            channelDescription = cachedChannel.description;
        } else {
            try {
                console.log('📡 Fetching channel snippet...');
                const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                    params: { part: 'snippet', id: channelId, key: YOUTUBE_API_KEY },
                    timeout: 5000 
                });
                if (channelRes.data.items[0]) {
                    channelName = channelRes.data.items[0].snippet.title;
                    channelDescription = channelRes.data.items[0].snippet.description;
                    setCache(channelCacheKey, { name: channelName, description: channelDescription });
                    console.log(`✅ Found channel: ${channelName}`);
                }
            } catch (err) { console.log('⚠️ Could not fetch channel details:', err.message); }
        }

        // Get top 5 videos (with caching)
        let topVideoTitles = [];
        const videosCacheKey = `videos_${channelId}`;
        const cachedVideos = getCached(videosCacheKey);

        if (cachedVideos) {
            console.log('♻️ Using cached video list');
            topVideoTitles = cachedVideos;
        } else {
            try {
                console.log('📡 Fetching top video titles...');
                const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                    params: { part: 'snippet', channelId, maxResults: 5, order: 'viewCount', type: 'video', key: YOUTUBE_API_KEY },
                    timeout: 5000
                });
                topVideoTitles = videosRes.data.items.map(v => v.snippet.title);
                setCache(videosCacheKey, topVideoTitles);
                console.log(`✅ Loaded ${topVideoTitles.length} video titles`);
            } catch (err) { console.log('⚠️ Could not fetch top videos:', err.message); }
        }

        console.log(`✅ Enrichment complete. Comments fetched: ${youtubeData?.comments?.length || 0}`);

        // Calculate aggregates from newest record
        const totalViews = latest.views || 0;
        const avgViews = (history.reduce((sum, r) => sum + (r.views || 0), 0) / history.length).toFixed(0);
        const totalSubsGained = history.reduce((sum, r) => sum + (r.subscribers_gained || 0), 0);

        // Advanced prompt following requested 3-step structure
        const prompt = `
System Prompt: You are "Massive Solver," an elite YouTube growth consultant. Analyze the channel data and follow these steps.

Steps:
1. Analyze Performance: Review the provided channel_data (views, subs). How is the channel performing?
2. Identify Content Gaps: Brainstorm 3 specific "Content Gaps"—topics the channel's audience wants but competitors aren't covering.
3. Recommend Strategy: Propose a high-potential video idea for each gap.
4. NEW: Sentiment Analysis: Analyze the recent audience comments. Are they positive? What are they asking for?

**Transparency Rule:** Whenever possible, cite specific top-performing videos from the provided list to justify your advice.

Channel Data JSON: 
${JSON.stringify({ 
    channel_name: channelName, 
    channel_description: channelDescription.substring(0, 300),
    total_views_tracked: totalViews,
    avg_views_per_period: avgViews,
    subs_gained_tracked: totalSubsGained,
    top_performing_videos: topVideoTitles,
    recent_comments: youtubeData?.comments || []
}, null, 2)}

Output Format: Provide a strategic report with these sections: 
### 1. Performance Review
### 2. Identified Content Gaps
### 3. Recommended Video Strategy
### 4. Audience Sentiment & Demands

Keep it actionable, professional, and under 800 words.`;

        console.log('🤖 Sending enriched blueprint to Gemma 3 12B...');
        const recommendations = await callGeminiWithRetry(prompt);

        res.json({
            success: true,
            data_points_analyzed: history.length,
            total_views: totalViews,
            avg_views: avgViews,
            channel_name: channelName,
            recommendations: recommendations
        });

    } catch (error) {
        console.error('❌ AI Analysis Error:', error);
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
