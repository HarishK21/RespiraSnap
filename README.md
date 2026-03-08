# RespiraSnap 🫁

*Built for Hack Canada 2026 🇨🇦*

RespiraSnap is an AI-powered respiratory analysis tool that provides immediate, actionable insights into your breathing patterns. By capturing a single 15-second breathing snapshot, the platform analyzes audio waveforms to detect inhales, holds, exhales, and irregularities, forming a comprehensive view of your current respiratory state.

In today's fast-paced world, breathing mechanics are often overlooked, yet they are a fundamental indicator of stress, focus, and overall nervous system regulation. RespiraSnap bridges the gap between subjective feeling and objective data, turning the microphone you already have into a powerful biosensor.

<img width="1919" height="941" alt="image" src="https://github.com/user-attachments/assets/1980da76-27f6-40fd-a09f-3991d5d30294" />


## How It Works
1. **Capture:** The user records 15 seconds of live breathing audio (guided by a calming voice coach) or uploads a pre-recorded sample.
2. **Analysis:** The platform extracts audio features (envelope and energy) directly in the browser, ensuring rapid processing and privacy.
3. **Orchestration:** The extracted waveform is sent to our backend where a team of specialized AI agents segment the breath cycle, compare it against historical baselines, and generate a clinical-style summary.
4. **Action:** The user receives immediate feedback, including their Rhythm stability, Exhale Ratio, a personalized micro-intervention (e.g., "Lengthen your exhale by one count"), and a prompt for their next session.

## Key Features
- **3-Step 15s Capture:** An intuitive, guided UI to capture high-quality audio samples effortlessly.
- **Waveform Analysis:** Precise extraction of audio energy and envelope data to track the respiratory cycle.
- **Clinician-Style Summaries:** Translates complex wave data into clear, non-diagnostic insights and actionable lifestyle coaching tips.
- **Historical Tracking:** Visualizes and compares core breathing pillars—Rhythm, Exhale Ratio, Interruptions, and Holds—across past sessions to track progress or regression.

<img width="1369" height="851" alt="image" src="https://github.com/user-attachments/assets/748f5a12-faaa-48f6-8162-e2f8ba789bf8" />


---

## Powered By Multi-Agent Orchestration & Voice

RespiraSnap leverages cutting-edge AI orchestration and emotional voice generation to provide a seamless, intelligent user experience.

### 🧠 Backboard API
Backboard powers the core intelligence and stateful memory of RespiraSnap. We deeply integrated the `backboard-sdk` to utilize several of its key features:

**1. Multi-Agent Orchestration**
Instead of relying on a single monolithic prompt, we use Backboard to divide the analysis into specialized, sequential tasks:
- **Segmentation Agent:** Analyzes the raw audio feature stats to estimate precise inhale/hold/exhale timings.
- **Baseline & Trend Agent:** Compares current snapshots against a user's historical data to track improvements or regressions over time.
- **Clinical Summary Agent:** Consolidates the segmentation data into a readable, clinician-style overview.
- **Coaching & Follow-Up Agents:** Generates personalized micro-interventions and creates a prompt for the user's next session.
These agents run concurrently and stream their intermediate states (Queued → Running → Done) via Server-Sent Events (SSE) directly to the frontend, giving users a live, transparent view of the AI pipeline at work.

<img width="1371" height="849" alt="image" src="https://github.com/user-attachments/assets/ccb2994d-32aa-46d2-9bc5-d88c0775599b" />
<img width="1364" height="851" alt="image" src="https://github.com/user-attachments/assets/f42f33c6-aaff-4a1e-bc8a-9409b8eb84be" />

**2. Conversational Memory (RAG)**
A key feature of RespiraSnap is its ability to understand a user's *baseline*. We use Backboard's native Memory API to silently store past snapshot data (energy variance, rhythm stability, scores) as conversational memory attached to the user's device ID. When the *Baseline & Trend Agent* runs, it automatically retrieves this historical context to provide accurate, personalized trend analysis without us needing to build a complex RAG pipeline from scratch.

<img width="1365" height="850" alt="image" src="https://github.com/user-attachments/assets/9df70e2c-e7e7-4ddd-817f-5f48b5e387c5" />

**3. Thread & State Management**
Every analysis session belongs to an ongoing Backboard Thread. This ensures that the Follow-up and Coaching agents have immediate, conversational context of what the Segmentation and Baseline agents just concluded, maintaining continuity across the pipeline.

### 🗣️ ElevenLabs (Voice Coach)
To ensure high-quality audio capture, a steady breathing rhythm is essential. We integrated **ElevenLabs** to power the Voice Coach:
- **Guidance During Capture:** The voice coach gently prompts the user ("Inhale...", "Hold...", "Exhale...") with a natural, calm, and human-like cadence.
- **Improved Data Quality:** By actively helping users pace their breaths, the resulting audio signal is significantly cleaner, leading to far more accurate downstream segmentation by the multi-agent pipeline.

---

## 🏆 Hackathon Categories Targeted

RespiraSnap was engineered specifically to highlight the unique strengths of our sponsors:

### 1. Backboard.io - Best use of Backboard
We moved beyond a simple chatbot and used Backboard as a **stateful AI operating system for a complex coordination problem** (respiratory analysis).
- **Multi-Agent Orchestration:** 4 distinct agents (Segmentation, Baseline, Clinical, Coaching) running sequentially on the same data.
- **Stateful Memory:** We utilize Backboard's Memory API to persist audio feature profiles securely under device IDs. The Baseline agent retrieves this without us building a separate vector database.
- **Context Persistence:** Health data shouldn't exist in a vacuum. By using threads and memory, RespiraSnap actually remembers if your rhythm was stable yesterday and adjusts its coaching today.

### 2. MLH x ElevenLabs - Best Project Built with ElevenLabs
We used ElevenLabs to build a **fully autonomous, interactive voice companion**.
- **Emotional Expressiveness:** Instead of robotic prompts, the ElevenLabs voice acts as a calming presence, actively pacing the user's nervous system during the 15-second capture window. This dynamic audio experience directly improves the quality of the physiological data we collect.

### 3. [MLH] Best Hack Built with Google Antigravity
RespiraSnap was built entirely within the Agentic Development platform, **Google Antigravity**. We utilized its context-aware agent and natural language code commands to orchestrate our Next.js frontend, complex audio waveform processing, and the Backboard API integration seamlessly.

---

## Tech Stack
- **Framework:** Next.js 14, React 18, TypeScript
- **Visuals & Animations:** CSS Modules, Framer Motion, React Three Fiber (3D visualizers)
- **AI/Agents:** Backboard SDK (`backboard-sdk`)
- **Voice/TTS:** ElevenLabs API
- **Database:** MongoDB (Atlas/Local) for user accounts and snapshot history.

## Getting Started

1. **Install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**
Create a `.env.local` file in the root directory:
```env
BACKBOARD_API_KEY=your_backboard_live_or_sandbox_key
BACKBOARD_BASE_URL=https://app.backboard.io/api
ELEVENLABS_API_KEY=your_elevenlabs_api_key
MONGODB_URI=mongodb://localhost:27017/respirasnap
```

3. **Run the development server:**
```bash
npm run dev
```

4. **Open the app:** Navigate to [http://localhost:3000](http://localhost:3000) in your browser.
