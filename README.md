# 🌍 Unbound: Your AI-Powered Global Journey Companion



> **Breaking down borders, one journey at a time.** 

[![](LiveDemo.mp4)](https://github.com/user-attachments/assets/57f2f38d-c99a-48f9-a306-032ad1727833)

> Unbound is a visionary, AI-driven platform designed to simplify global mobility. Whether you are navigating complex visa matrices, exploring relocation opportunities, or managing immigration documents, Unbound acts as your intelligent co-pilot, turning the daunting process of global relocation into a seamless, empowering experience.



---



## ✨ The Vision & Biggest Topics



Unbound tackles the complexities of global travel and immigration through cutting-edge technology. Here are the massive challenges this repository solves:



*   **🤖 AI-Agentic Orchestration:** At the heart of Unbound is an advanced LLM-powered orchestrator. It autonomously processes guidelines, evaluates rules, and assists users through a conversational interface (`app/agents/orchestrator.py`).

*   **🗺️ Interactive Global Exploration:** A stunning, interactive 3D Globe view (`GlobeView.tsx`) paired with a robust Visa Matrix database allows users to visually explore their global mobility options and visa requirements in real-time.

*   **📄 Automated Document Pipeline:** Bureaucracy, simplified. Unbound features a complete document processing pipeline (`app/pipeline/`) capable of extracting, fetching, and verifying data from uploaded PDFs and forms.

*   **🛤️ Intelligent Journey Management:** From initial exploration to final document submission, the platform tracks holistic user "Journeys", managing finances, tasks (ToDos), and case files securely.

*   **🌐 True Localization:** Built from the ground up for a global audience with native i18n support (English, Hungarian, Russian).


---



## 🚀 Tech Stack



**Frontend:**

*   **React + Vite**: High-performance UI rendering.

*   **Tailwind CSS**: Rapid, responsive styling.

*   **Three.js / WebGL** (Implied): For the interactive Globe View.

*   **i18n**: Internationalization logic.



**Backend:**

*   **Python**: Core logic and AI scripting.

*   **Agentic LLM Framework**: Custom rules and orchestrator layers for interacting with Large Language Models.

*   **Document Processing**: Automated PDF handling and data extraction.



**DevOps & Deployment:**

*   **Docker & Docker Compose**: Fully containerized for local development and production.

*   **Caddy**: Reverse proxy and automated HTTPS.



---



## 🛠️ Getting Started



Unbound is completely containerized, making local development a breeze.



### Prerequisites

*   [Docker](https://www.docker.com/) & Docker Compose

*   [Node.js](https://nodejs.org/) (for local frontend development)

*   Python 3.10+



### Quickstart



1. **Clone the repository:**

   ```bash

   git clone https://github.com/your-org/unbound.git

   cd unbound

   ```



2. **Environment Setup:**

   Copy the example environment files and fill in your API keys (especially your LLM provider keys).

   ```bash

   cp .env.example .env

   cp frontend/.env.example frontend/.env

   ```



3. **Launch the Stack:**

   Spin up the entire application using Docker Compose.

   ```bash

   docker-compose -f docker-compose.local.yml up --build

   ```



4. **Explore:**

   * Frontend: `http://localhost:3000` (or as configured)

   * Backend API Docs: `http://localhost:8000/docs`






*Built with passion during the Fall Hackathon.* 🍂🚀
