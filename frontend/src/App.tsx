import { useState, useEffect } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  Tooltip, CartesianGrid 
} from 'recharts';

// Simple login placeholder (no real auth for MVP)
function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) onLogin();
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center p-4">
      <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 w-full max-w-md border border-white/20">
        <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 mb-2">Massive Solver</h1>
        <p className="text-gray-300 mb-6">AI Engine for Creators</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Enter any email (MVP mode)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2 rounded-lg bg-white/20 border border-white/30 text-white placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500"
            required
          />
          <button type="submit" className="w-full py-2 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold hover:opacity-90 transition">
            Enter Dashboard
          </button>
        </form>
      </div>
    </div>
  );
}

// Simple retry helper
const fetchWithRetry = async (fn: () => Promise<any>, retries = 3, delay = 1000): Promise<any> => {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(fn, retries - 1, delay * 2);
  }
};

// Dashboard component
function Dashboard() {
  const [channelId, setChannelId] = useState('UCwTMRMFBYAoTAmhHO6s3Mag'); // Phase 2: multi-channel
  const [stats, setStats] = useState({ views: 0, subscribers: 0, videoCount: 0, topVideo: null, lastUpdated: null });
  const [history, setHistory] = useState([]);
  const [recommendations, setRecommendations] = useState('');
  const [loading, setLoading] = useState({ stats: true, ai: true, sync: false, history: true });
  const [error, setError] = useState('');

  const fetchHistory = async () => {
    try {
      const res = await fetchWithRetry(() => axios.get(`${import.meta.env.VITE_API_URL}/api/history?channelId=${channelId}`));
      setHistory(res.data);
    } catch (err) {
      console.error('Failed to load history after retries');
    } finally {
      setLoading(prev => ({ ...prev, history: false }));
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetchWithRetry(() => axios.get(`${import.meta.env.VITE_API_URL}/api/stats?channelId=${channelId}`, { timeout: 30000 }));
      setStats(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load stats');
    } finally {
      setLoading(prev => ({ ...prev, stats: false }));
    }
  };

  const fetchAI = async (selectedChannelId: string) => {
    try {
      const res = await fetchWithRetry(() => axios.get(`${import.meta.env.VITE_API_URL}/analyze?channelId=${selectedChannelId}`, { timeout: 45000 }));
      setRecommendations(res.data.recommendations);
    } catch (err) {
      setError('AI analysis failed');
    } finally {
      setLoading(prev => ({ ...prev, ai: false }));
    }
  };

  const handleSync = async (targetChannelId: string) => {
    setLoading(prev => ({ ...prev, sync: true }));
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}/api/sync`, { channelId: targetChannelId });
      await Promise.all([fetchStats(), fetchAI(targetChannelId), fetchHistory()]);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Sync failed');
    } finally {
      setLoading(prev => ({ ...prev, sync: false }));
    }
  };

  useEffect(() => {
    fetchStats();
    fetchAI(channelId);
    fetchHistory();
  }, []);

  if (loading.stats) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading stats...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">Massive Solver</h1>
          <button
            onClick={() => handleSync(channelId)}
            disabled={loading.sync}
            className="px-4 py-2 bg-white/20 rounded-lg hover:bg-white/30 transition disabled:opacity-50"
          >
            {loading.sync ? 'Syncing...' : '🔄 Refresh Data'}
          </button>
        </div>

        {/* Phase 2: Channel ID Input */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20 mb-8">
          <label className="block text-gray-300 mb-2 font-medium">YouTube Channel ID</label>
          <div className="flex gap-4">
            <input
              type="text"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className="flex-1 px-4 py-2 rounded-lg bg-white/20 border border-white/30 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
              placeholder="Enter YouTube Channel ID"
            />
            <button
              onClick={() => handleSync(channelId)}
              disabled={loading.sync}
              className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg text-white font-semibold hover:opacity-90 transition disabled:opacity-50"
            >
              Sync Channel
            </button>
          </div>
        </div>

        {error && <div className="bg-red-500/20 border border-red-500 rounded-lg p-3 mb-6 text-red-200">{error}</div>}

        {/* Stats Grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-gray-400 text-sm uppercase">Total Views</h3>
            <p className="text-4xl font-bold text-white mt-2">{stats.views.toLocaleString()}</p>
          </div>
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-gray-400 text-sm uppercase">Subscribers</h3>
            <p className="text-4xl font-bold text-white mt-2">{stats.subscribers.toLocaleString()}</p>
          </div>
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-gray-400 text-sm uppercase">Videos</h3>
            <p className="text-4xl font-bold text-white mt-2">{stats.videoCount}</p>
          </div>
        </div>

        {/* View Trends Chart */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20 mb-8 h-[350px] min-h-[350px]">
          <h3 className="text-gray-400 text-sm uppercase mb-4">View Performance Trend</h3>
          {loading.history ? (
            <div className="flex items-center justify-center h-full text-gray-500">Generating chart...</div>
          ) : history.length > 1 ? (
            <ResponsiveContainer width="100%" height="90%" minWidth={0}>
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="colorViews" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  stroke="#9ca3af" 
                  fontSize={12} 
                  tickFormatter={(str) => new Date(str).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                />
                <YAxis stroke="#9ca3af" fontSize={12} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px', color: '#fff' }} 
                  itemStyle={{ color: '#a78bfa' }}
                />
                <Area type="monotone" dataKey="views" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorViews)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">Not enough historical data points for a trend chart. Sync more often!</div>
          )}
        </div>

        {/* AI Recommendations */}
        <div className="bg-white/5 rounded-xl p-6 border border-white/10 min-h-[300px]">
          <h2 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 mb-4">
            🧠 Growth Blueprint
          </h2>
          <div className="prose prose-invert prose-sm max-w-none text-gray-200">
            {loading.ai ? (
              <div className="animate-pulse space-y-4">
                <div className="h-4 bg-white/10 rounded w-3/4"></div>
                <div className="h-4 bg-white/10 rounded w-5/6"></div>
                <div className="h-4 bg-white/10 rounded w-2/3"></div>
                <p className="text-purple-300">Strategic engine is calculating niche gaps...</p>
              </div>
            ) : recommendations ? (
              <>
                <div className="space-y-4">
                  {recommendations.split('\n').map((line, idx) => {
                    if (line.startsWith('###')) {
                      return <h3 key={idx} className="text-lg font-bold text-purple-300 mt-6 mb-2 border-b border-white/10 pb-1">{line.replace('###', '').trim()}</h3>;
                    } else if (line.match(/^\d+\./)) {
                      return <div key={idx} className="ml-4 mb-2 text-gray-200 font-medium">{line}</div>;
                    } else if (line.startsWith('-') || line.startsWith('*')) {
                      return <div key={idx} className="ml-6 mb-1 text-gray-300">• {line.replace(/^[-*]\s*/, '')}</div>;
                    } else if (line.trim() === '') {
                      return <div key={idx} className="h-2" />;
                    } else {
                      return <p key={idx} className="mb-2 leading-relaxed">{line}</p>;
                    }
                  })}
                </div>
                <div className="mt-8 pt-4 border-t border-white/10 flex items-center justify-between">
                  <div className="text-[10px] text-gray-500 italic max-w-md">
                    Disclaimer: AI-generated growth strategies are suggestions based on historical data. Results are not guaranteed. Always verify trends through YouTube Studio Research tab.
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs text-gray-400">Was this helpful?</span>
                    <div className="flex gap-2">
                       <button 
                        onClick={() => axios.post(`${import.meta.env.VITE_API_URL}/api/feedback`, { rating: 1, feedback: 'Up' })}
                        className="p-1 hover:bg-white/10 rounded-md transition" title="Yes"
                       >
                         👍
                       </button>
                       <button 
                        onClick={() => axios.post(`${import.meta.env.VITE_API_URL}/api/feedback`, { rating: 0, feedback: 'Down' })}
                        className="p-1 hover:bg-white/10 rounded-md transition" title="No"
                       >
                         👎
                       </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p>No blueprint generated. Sync your channel to begin.</p>
            )}
          </div>
        </div>

        {/* Last updated */}
        {stats.lastUpdated && (
          <div className="text-right text-gray-500 text-sm mt-4">
            Last updated: {new Date(stats.lastUpdated).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}

// Main App with routing
function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={isLoggedIn ? <Navigate to="/dashboard" /> : <Login onLogin={() => setIsLoggedIn(true)} />} />
        <Route path="/dashboard" element={isLoggedIn ? <Dashboard /> : <Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
