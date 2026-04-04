const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

        return {
            channel_id: channelId,
            views: parseInt(stats.viewCount) || 0,
            subscribers: parseInt(stats.subscriberCount) || 0,
            video_count: parseInt(stats.videoCount) || 0,
            top_videos: topVideos,
            fetched_at: new Date().toISOString()
        };
    } catch (error) {
        console.error('YouTube API Error:', error.response?.data || error.message);
        throw error;
    }
}

// Sync to Xano
async function syncToXano(data) {
    try {
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics`;

        const payload = {
            user: 1,
            date: new Date().toISOString().split('T')[0],
            channel_id: data.channel_id, // Added for Phase 2
            views: data.views,
            subscribers_gained: 0,
            subscribers_lost: 0,
            top_video_id: data.top_videos[0]?.id || '',
            top_video_title: data.top_videos[0]?.title || '',
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
    try {
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

        // Get latest record
        const latest = history[history.length - 1];
        const channelId = latest.channel_id;
        
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

        // Calculate aggregates
        const totalViews = history.reduce((sum, r) => sum + (r.views || 0), 0);
        const avgViews = (totalViews / history.length).toFixed(0);
        const totalSubsGained = history.reduce((sum, r) => sum + (r.subscribers_gained || 0), 0);

        // Advanced prompt following requested 3-step structure
        const prompt = `
System Prompt: You are "Massive Solver," an elite YouTube growth consultant. Analyze the channel data and follow these steps.

Steps:
1. Analyze Performance: Review the provided channel_data (views, subs). How is the channel performing?
2. Identify Content Gaps: Based on your knowledge of the YouTube niche, brainstorm 3 specific "Content Gaps"—topics the channel's audience wants but competitors aren't adequately covering.
3. Recommend Strategy: For each gap, propose a high-potential video idea, including a working title and a brief description of the unique angle.

**Transparency Rule:** Whenever possible, cite specific top-performing videos from the provided list to justify your advice (e.g., "Inspired by your success with '...'").

Channel Data JSON: 
${JSON.stringify({ 
    channel_name: channelName, 
    channel_description: channelDescription.substring(0, 300),
    total_views_tracked: totalViews,
    avg_views_per_period: avgViews,
    subs_gained_tracked: totalSubsGained,
    top_performing_videos: topVideoTitles
}, null, 2)}

Inferred Niche: Based on titles "${topVideoTitles.join(', ')}", determine the niche and provide tailored advice.

Output Format: Provide a strategic report with three sections: 
### 1. Performance Review
### 2. Identified Content Gaps
### 3. Recommended Video Strategy

Keep it actionable, professional, and under 700 words.`;

        console.log('🤖 Sending ultra-strategic prompt to Gemini...');
        const model = genAI.getGenerativeModel({ model: "gemma-3-12b-it" });
        const result = await model.generateContent(prompt);
        const recommendations = result.response.text();

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
            // Also fetch live stats from YouTube for this channel
            const liveStats = await fetchYouTubeStats(channelId);
            res.json({
                views: latest.views || liveStats.views || 0,
                subscribers: liveStats.subscribers || 0,
                videoCount: liveStats.video_count || 0,
                topVideo: latest.top_video_title || 'None',
                lastUpdated: latest.created_at
            });
        } else {
            // No historical data, but still fetch live stats
            const liveStats = await fetchYouTubeStats(channelId);
            res.json({
                views: liveStats.views || 0,
                subscribers: liveStats.subscribers || 0,
                videoCount: liveStats.video_count || 0,
                topVideo: null,
                lastUpdated: null
            });
        }
    } catch (error) {
        console.error('Stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
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
        const xanoResult = await syncToXano(youtubeData);
        res.json({ success: true, message: 'Sync completed', data: xanoResult });
    } catch (error) {
        console.error('Sync error:', error.message);
        res.status(500).json({ error: 'Sync failed' });
    }
});

app.listen(process.env.PORT || 5000, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${process.env.PORT || 5000}`);
    console.log(`📊 Test sync: http://localhost:${process.env.PORT || 5000}/test/youtube`);
    console.log(`🧠 AI analysis: http://localhost:${process.env.PORT || 5000}/analyze`);
});
