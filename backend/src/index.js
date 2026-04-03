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

// Root route
app.get('/', (req, res) => {
    res.send('Massive Solver API is running. Use /ping, /analyze, /api/stats');
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

// NEW: Fetch historical data from Xano
async function getHistoricalData() {
    try {
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics`;
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

// NEW: AI Analysis Endpoint
app.get('/analyze', async (req, res) => {
    try {
        console.log('📊 Fetching historical data from Xano...');
        const history = await getHistoricalData();
        
        if (!history || history.length === 0) {
            return res.json({
                success: true,
                message: "Not enough data yet. Sync your YouTube stats first using /test/youtube.",
                data_points_analyzed: 0,
                recommendations: "Keep uploading content! Once you have more data, I can give you better advice."
            });
        }

        console.log(`📈 Found ${history.length} records. Preparing data for AI...`);

        // --- 1. Prepare Your Data for the AI ---
        const totalViews = history.reduce((sum, record) => sum + (record.views || 0), 0);
        const avgViews = history.length > 0 ? (totalViews / history.length).toFixed(2) : 0;
        const latestStats = history[history.length - 1];

        // --- 2. Create an Effective Prompt for the AI ---
        const prompt = `
You are "Massive Solver", an expert YouTube growth consultant for a small channel.
Analyze the following channel data and provide 3 specific, actionable recommendations.
Be encouraging and focus on practical steps a small creator can take.

Channel Data (from the last ${history.length} days of tracking):
- Channel ID: ${latestStats?.user || 'N/A'}
- Total Views (All Time): ${totalViews}
- Average Views Per Tracking Period: ${avgViews}
- Latest Subscriber Count: ${latestStats?.subscribers_gained || 0}
- Latest Top Video: "${latestStats?.top_video_title || 'None'}"

Based on this data, provide:
1.  A content strategy recommendation.
2.  A recommendation for titles, thumbnails, or SEO.
3.  A community engagement or promotion tip.

Format the response as a clean list with clear headings.
        `;

        console.log('🤖 Sending data to Gemini for analysis...');

        // --- 3. Call the Gemini API ---
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const recommendations = result.response.text();

        // --- 4. Send the AI's Response Back to Your Frontend ---
        res.json({
            success: true,
            data_points_analyzed: history.length,
            total_views: totalViews,
            avg_views: avgViews,
            recommendations: recommendations
        });

    } catch (error) {
        console.error('❌ AI Analysis Error:', error);
        res.status(500).json({
            error: 'Analysis failed',
            details: error.message
        });
    }
});

// Original test endpoint (kept for compatibility)
app.get('/test/youtube', async (req, res) => {
    try {
        console.log('Fetching YouTube stats...');
        const youtubeData = await fetchYouTubeStats();
        
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
    try {
        const xanoUrl = `${XANO_BASE_URL}/youtube_analytics?user_id=1&_sort=-date&_limit=1`;
        const response = await axios.get(xanoUrl, {
            headers: { 'Authorization': `Bearer ${XANO_API_KEY}` }
        });
        
        if (response.data && response.data.length > 0) {
            const latest = response.data[0];
            // For MVP, we don't have real subscriber count. Fetch from YouTube live.
            // Let's add a live fetch for subscribers
            const youtubeStats = await fetchYouTubeStats(); // reuse existing function
            res.json({
                views: latest.views,
                subscribers: youtubeStats.subscribers, // real subscriber count from YouTube API
                videoCount: youtubeStats.video_count,
                topVideo: latest.top_video_title || 'None',
                lastUpdated: latest.created_at
            });
        } else {
            res.json({ views: 0, subscribers: 0, videoCount: 0, topVideo: null, lastUpdated: null });
        }
    } catch (error) {
        console.error('Stats error:', error.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Test sync: http://localhost:${PORT}/test/youtube`);
    console.log(`🧠 AI analysis: http://localhost:${PORT}/analyze`);
});
