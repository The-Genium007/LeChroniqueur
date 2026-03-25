import fs from 'node:fs';
import path from 'node:path';
import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';

export interface FinalScript {
  readonly textOverlay: string;
  readonly fullScript: string;
  readonly hashtags: string;
  readonly platform: string;
  readonly suggestedTime: string;
  readonly notes: string;
}

let _personaPrompt: string | undefined;

function loadPersona(): string {
  if (_personaPrompt !== undefined) {
    return _personaPrompt;
  }

  const skillPath = path.join(process.cwd(), 'prompts', 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    return 'Tu es Le Chroniqueur, un MJ légendaire francophone. Tutoiement, sarcasme taquin, références JDR.';
  }

  _personaPrompt = fs.readFileSync(skillPath, 'utf-8');
  return _personaPrompt;
}

export async function generateFinalScript(
  suggestionContent: string,
  platform: string,
  format: string,
): Promise<FinalScript> {
  const logger = getLogger();
  const persona = loadPersona();

  const userMessage = [
    'Transforme cette suggestion en script FINAL prêt à produire.',
    '',
    `PLATEFORME : ${platform}`,
    `FORMAT : ${format}`,
    '',
    'SUGGESTION :',
    suggestionContent,
    '',
    'GÉNÈRE :',
    '1. textOverlay : le texte exact qui apparaît à l\'écran (overlay), avec les timecodes si c\'est une vidéo, ou les slides si c\'est un carrousel',
    '2. fullScript : le déroulé de production complet (ce qu\'on voit à l\'écran seconde par seconde, ou slide par slide)',
    '3. hashtags : les hashtags optimaux, séparés par des espaces',
    '4. suggestedTime : créneau de publication optimal',
    '5. notes : notes de production pour le créateur (assets à préparer, captures à faire, musique suggérée)',
    '',
    'RÈGLES :',
    '- Le texte overlay doit être COURT et PERCUTANT',
    '- Le script doit être assez détaillé pour qu\'un créateur puisse produire le contenu sans poser de questions',
    '- Tutoiement total, ton du Chroniqueur',
    '- Emojis autorisés : 🎲 ⚔️ 🐉 🔥 💀 📜 ✨',
    '',
    'Réponds en JSON :',
    '{"textOverlay": "...", "fullScript": "...", "hashtags": "...", "platform": "...", "suggestedTime": "...", "notes": "..."}',
  ].join('\n');

  const response = await complete(persona, userMessage, {
    maxTokens: 3072,
    temperature: 0.7,
  });

  try {
    let jsonText = response.text.trim();
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.slice(7);
    }
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.slice(0, -3);
    }
    jsonText = jsonText.trim();

    const raw = JSON.parse(jsonText) as Record<string, unknown>;

    return {
      textOverlay: String(raw['textOverlay'] ?? ''),
      fullScript: String(raw['fullScript'] ?? ''),
      hashtags: String(raw['hashtags'] ?? ''),
      platform: String(raw['platform'] ?? platform),
      suggestedTime: String(raw['suggestedTime'] ?? ''),
      notes: String(raw['notes'] ?? ''),
    };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to parse final script response, returning raw text',
    );

    return {
      textOverlay: '',
      fullScript: response.text,
      hashtags: '',
      platform,
      suggestedTime: '',
      notes: '',
    };
  }
}
