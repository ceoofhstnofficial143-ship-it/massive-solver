import { useState, useEffect } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

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

// Dashboard component
function Dashboard() {
  const [channelId, setChannelId] = useState('UCwTMRMFBYAoTAmhHO6s3Mag'); // Phase 2: multi-channel
  const [stats, setStats] = useState({ views: 0, subscribers: 0, videoCount: 0, topVideo: null, lastUpdated: null });
  const [recommendations, setRecommendations] = useState('');
  const [loading, setLoading] = useState({ stats: true, ai: true, sync: false });
  const [error, setError] = useState('');

  const fetchStats = async () => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}/api/stats?channelId=${channelId}`);
      setStats(res.data);
    } catch (err) {
      setError('Failed to load stats');
    } finally {
      setLoading(prev => ({ ...prev, stats: false }));
    }
  };

  const fetchAI = async () => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}/analyze`);
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
      await fetchStats();  // refresh stats after sync
      await fetchAI();     // refresh AI recommendations
    } catch (err) {
      setError('Sync failed');
    } finally {
      setLoading(prev => ({ ...prev, sync: false }));
    }
  };

  useEffect(() => {
    fetchStats();
    fetchAI();
  }, []);

  if (loading.stats || loading.ai) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading your engine...</div>
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

        {/* AI Recommendations */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
          <h2 className="text-xl font-semibold text-white mb-4">🧠 AI Growth Recommendations</h2>
          <div className="prose prose-invert max-w-none text-gray-200 whitespace-pre-wrap leading-relaxed">
            {recommendations.split('\n').map((line, idx) => {
              if (line.startsWith('##')) {
                return <h3 key={idx} className="text-xl font-bold text-purple-300 mt-4 mb-2">{line.replace('##', '').trim()}</h3>;
              } else if (line.startsWith('-') || line.match(/^\d+\./)) {
                return <li key={idx} className="ml-4 mb-1 list-disc">{line.replace(/^- /, '')}</li>;
              } else if (line.trim() === '') {
                return <div key={idx} className="h-2" />;
              } else {
                return <p key={idx} className="mb-2">{line}</p>;
              }
            })}
            {!recommendations && <p>No recommendations yet. Sync your data first.</p>}
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
