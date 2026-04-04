const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ========== Clients ==========
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ========== Helper: Fetch YouTube stats (live) ==========
async function fetchYouTubeStats(channelId) {
    try {
        // Channel statistics
        const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
            params: {
                part: 'statistics,snippet',
                id: channelId,
                key: process.env.YOUTUBE_API_KEY
            }
        });
        const stats = channelRes.data.items[0]?.statistics || {};
        const snippet = channelRes.data.items[0]?.snippet || {};
        
        // Top 3 videos
        const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                maxResults: 3,
                order: 'viewCount',
                type: 'video',
                key: process.env.YOUTUBE_API_KEY
            }
        });
        const topVideos = videosRes.data.items.map(v => ({
            id: v.id.videoId,
            title: v.snippet.title,
            thumbnail: v.snippet.thumbnails.default.url
        }));

        return {
            channel_id: channelId,
            channel_name: snippet.title || 'Unknown',
            views: parseInt(stats.viewCount) || 0,
            subscribers: parseInt(stats.subscriberCount) || 0,
            video_count: parseInt(stats.videoCount) || 0,
            top_videos: topVideos
        };
    } catch (error) {
        console.error('YouTube API error:', error.response?.data || error.message);
        throw error;
    }
}

// ========== Helper: Insert a sync record into Supabase ==========
async function insertSyncRecord(channelId, stats, topVideoId, topVideoTitle) {
    const { error } = await supabase
        .from('youtube_analytics')
        .insert({
            channel_id: channelId,
            user_id: '1',   // placeholder, will be replaced with real user ID later
            date: new Date().toISOString().split('T')[0],
            views: stats.views,
            subscribers_gained: stats.subscribers,
            subscribers_lost: 0,
            top_video_id: topVideoId || '',
            top_video_title: topVideoTitle || '',
            top_video_views: 0
        });
    if (error) console.error('Insert error:', error);
    return !error;
}

// ========== Helper: Fetch transcript (using caption-extractor) ==========
const { getSubtitles } = require('caption-extractor');

async function fetchAndStoreTranscript(videoId, channelId) {
    try {
        const { subtitles } = await getSubtitles({ videoId, lang: 'en' });
        const fullTranscript = (subtitles || []).map(s => s.text).join(' ');
        
        const { error } = await supabase
            .from('transcripts')
            .upsert({
                video_id: videoId,
                channel_id: channelId,
                transcript_text: fullTranscript,
                analyzed_flag: false,
                fetched_at: new Date().toISOString()
            }, { onConflict: 'video_id' });
        if (error) throw error;
        console.log(`✅ Transcript saved for ${videoId}`);
        return true;
    } catch (err) {
        console.warn(`⚠️ No transcript for ${videoId}: ${err.message}`);
        return false;
    }
}

// ========== Helper: Fetch and analyze comments sentiment ==========
const Sentiment = require('sentiment');
const sentiment = new Sentiment();

async function fetchAndStoreComments(videoId, channelId) {
    try {
        const commentsUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=100&key=${process.env.YOUTUBE_API_KEY}`;
        const res = await axios.get(commentsUrl);
        const commentItems = res.data.items || [];
        if (commentItems.length === 0) return false;

        for (const item of commentItems) {
            const text = item.snippet.topLevelComment.snippet.textDisplay;
            const score = sentiment.analyze(text).score;
            const { error } = await supabase
                .from('comments')
                .insert({
                    video_id: videoId,
                    channel_id: channelId,
                    comment_text: text,
                    sentiment_score: score,
                    analyzed_flag: true,
                    fetched_at: new Date().toISOString()
                });
            if (error) console.error('Comment insert error:', error);
        }
        console.log(`✅ Comments analyzed for ${videoId}`);
        return true;
    } catch (err) {
        console.warn(`⚠️ Could not fetch comments for ${videoId}: ${err.message}`);
        return false;
    }
}

// ========== Endpoint: Health check ==========
app.get('/ping', (req, res) => res.send('pong'));

// ========== Endpoint: Get latest stats ==========
app.get('/api/stats', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    try {
        const { data, error } = await supabase
            .from('youtube_analytics')
            .select('views, subscribers_gained, top_video_title, created_at')
            .eq('channel_id', channelId)
            .order('date', { ascending: false })
            .limit(1);
        if (error) throw error;
        if (data && data.length > 0) {
            // Also get live subscribers from YouTube (to keep current)
            const live = await fetchYouTubeStats(channelId).catch(() => null);
            res.json({
                views: data[0].views,
                subscribers: live?.subscribers || 0,
                videoCount: live?.video_count || 0,
                topVideo: data[0].top_video_title || 'None',
                lastUpdated: data[0].created_at
            });
        } else {
            // No history – fallback to live stats only
            const live = await fetchYouTubeStats(channelId).catch(() => null);
            if (!live) return res.status(429).json({ error: 'YouTube quota exceeded and no history found' });
            res.json({
                views: live.views,
                subscribers: live.subscribers,
                videoCount: live.video_count,
                topVideo: null,
                lastUpdated: null
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== Endpoint: History for chart ==========
app.get('/api/history', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    try {
        const { data, error } = await supabase
            .from('youtube_analytics')
            .select('date, views')
            .eq('channel_id', channelId)
            .gt('views', 0)
            .order('date', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== Endpoint: Sync (main pipeline) ==========
app.post('/api/sync', async (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    try {
        // 1. Fetch fresh YouTube stats
        const youtubeData = await fetchYouTubeStats(channelId);
        const topVideoId = youtubeData.top_videos[0]?.id || '';
        const topVideoTitle = youtubeData.top_videos[0]?.title || '';

        // 2. Insert into youtube_analytics
        await insertSyncRecord(channelId, youtubeData, topVideoId, topVideoTitle);

        // 3. Fetch transcript and comments for top 3 videos
        for (const video of youtubeData.top_videos) {
            await fetchAndStoreTranscript(video.id, channelId);
            await fetchAndStoreComments(video.id, channelId);
        }

        res.json({ success: true, message: 'Sync completed', stats: youtubeData });
    } catch (err) {
        console.error('Sync error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== Endpoint: AI Analysis (grounded) ==========
app.get('/analyze', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    try {
        // 1. Get latest stats record
        const { data: statsData, error: statsErr } = await supabase
            .from('youtube_analytics')
            .select('*')
            .eq('channel_id', channelId)
            .order('date', { ascending: false })
            .limit(1);
        if (statsErr) throw statsErr;
        if (!statsData || statsData.length === 0) {
            return res.json({ success: true, recommendations: "No data yet. Sync this channel first." });
        }
        const latest = statsData[0];

        // 2. Get transcripts (latest 5)
        const { data: transcripts, error: transErr } = await supabase
            .from('transcripts')
            .select('transcript_text')
            .eq('channel_id', channelId)
            .limit(5);
        if (transErr) console.error('Transcript fetch error:', transErr);

        // 3. Get comments sentiment (latest 100)
        const { data: comments, error: commErr } = await supabase
            .from('comments')
            .select('sentiment_score, comment_text')
            .eq('channel_id', channelId)
            .limit(100);
        if (commErr) console.error('Comments fetch error:', commErr);

        // Calculate average sentiment
        let avgSentiment = 0;
        if (comments && comments.length) {
            const sum = comments.reduce((acc, c) => acc + (c.sentiment_score || 0), 0);
            avgSentiment = (sum / comments.length).toFixed(2);
        }

        const totalViews = latest.views;
        const avgViews = (totalViews / (latest.top_video_id ? 1 : 1)).toFixed(0); // placeholder

        // 4. Build prompt (grounded)
        const prompt = `You are "Massive Solver", an elite YouTube growth consultant.

**ABSOLUTE FACTS – DO NOT INVENT OR MULTIPLY NUMBERS:**
- Total lifetime views: ${totalViews}
- Average views per video (approx): ${avgViews}
- Current subscribers: ${latest.subscribers_gained || 0}

**Video Transcript Excerpts (top videos):**
${transcripts?.map(t => t.transcript_text?.substring(0, 500)).join('\n---\n') || 'No transcripts available.'}

**Audience Sentiment Analysis:**
- Average sentiment score (from -5 to +5): ${avgSentiment}
- Positive comments example: ${comments?.filter(c => c.sentiment_score > 2).slice(0, 2).map(c => c.comment_text).join('; ') || 'None'}
- Negative comments example: ${comments?.filter(c => c.sentiment_score < -2).slice(0, 2).map(c => c.comment_text).join('; ') || 'None'}

**Your Task:**
Based on the transcripts and sentiment, create a growth blueprint with:
1. **Content Gaps** – What topics are missing? (Cite evidence from transcripts/comments)
2. **Tone & Delivery** – How can the creator improve engagement?
3. **Three video ideas** – Each with a title, unique angle, and why it addresses audience feedback.

Be specific, use quotes or sentiment examples, keep under 600 words.`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You are a YouTube growth expert. Provide clear, evidence‑based advice." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.5,
            max_tokens: 1024,
        });
        const recommendations = chatCompletion.choices[0]?.message?.content || "No response from AI.";

        res.json({
            success: true,
            data_points_analyzed: 1,
            total_views: totalViews,
            avg_views: avgViews,
            recommendations: recommendations
        });
    } catch (err) {
        console.error('Analysis error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== Debug endpoint ==========
app.get('/debug-youtube', async (req, res) => {
    const { channelId } = req.query;
    try {
        const data = await fetchYouTubeStats(channelId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Massive Solver backend running on port ${PORT}`);
});
