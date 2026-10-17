// Logos des fournisseurs (@lobehub/icons-static-svg, MIT), importés en URL Vite : tout est servi par le bundle,
// aucune URL externe (CSP de production : img-src 'self' data: blob:).
import openai from '@lobehub/icons-static-svg/icons/openai.svg?url';
import claudeColor from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import geminiColor from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import mistralColor from '@lobehub/icons-static-svg/icons/mistral-color.svg?url';
import deepseekColor from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import qwenColor from '@lobehub/icons-static-svg/icons/qwen-color.svg?url';
import kimiColor from '@lobehub/icons-static-svg/icons/kimi-color.svg?url';
import metaColor from '@lobehub/icons-static-svg/icons/meta-color.svg?url';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?url';
import zhipuColor from '@lobehub/icons-static-svg/icons/zhipu-color.svg?url';
import doubaoColor from '@lobehub/icons-static-svg/icons/doubao-color.svg?url';
import minimaxColor from '@lobehub/icons-static-svg/icons/minimax-color.svg?url';
import yiColor from '@lobehub/icons-static-svg/icons/yi-color.svg?url';
import baichuanColor from '@lobehub/icons-static-svg/icons/baichuan-color.svg?url';
import hunyuanColor from '@lobehub/icons-static-svg/icons/hunyuan-color.svg?url';
import wenxinColor from '@lobehub/icons-static-svg/icons/wenxin-color.svg?url';
import stepfunColor from '@lobehub/icons-static-svg/icons/stepfun-color.svg?url';
import sparkColor from '@lobehub/icons-static-svg/icons/spark-color.svg?url';
import sensenovaColor from '@lobehub/icons-static-svg/icons/sensenova-color.svg?url';
import internlmColor from '@lobehub/icons-static-svg/icons/internlm-color.svg?url';
import cohereColor from '@lobehub/icons-static-svg/icons/cohere-color.svg?url';
import perplexityColor from '@lobehub/icons-static-svg/icons/perplexity-color.svg?url';
import microsoftColor from '@lobehub/icons-static-svg/icons/microsoft-color.svg?url';
import nvidiaColor from '@lobehub/icons-static-svg/icons/nvidia-color.svg?url';
import upstageColor from '@lobehub/icons-static-svg/icons/upstage-color.svg?url';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?url';
import groq from '@lobehub/icons-static-svg/icons/groq.svg?url';
import togetherColor from '@lobehub/icons-static-svg/icons/together-color.svg?url';
import fireworksColor from '@lobehub/icons-static-svg/icons/fireworks-color.svg?url';
import huggingfaceColor from '@lobehub/icons-static-svg/icons/huggingface-color.svg?url';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?url';
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?url';

export type MainProvider = { name: string; icon: string; color: string };
export type MoreProvider = { name: string; icon: string };

/** Les 8 fournisseurs de la scène (ordre de haut en bas), avec leur couleur d'anneau. */
export const MAIN_PROVIDERS: readonly MainProvider[] = [
  { name: 'OpenAI', icon: openai, color: '#e9eef2' },
  { name: 'Claude', icon: claudeColor, color: '#D97757' },
  { name: 'Gemini', icon: geminiColor, color: '#4285F4' },
  { name: 'Mistral', icon: mistralColor, color: '#FA520F' },
  { name: 'DeepSeek', icon: deepseekColor, color: '#4D6BFE' },
  { name: 'Qwen', icon: qwenColor, color: '#8A7CFF' },
  { name: 'Kimi', icon: kimiColor, color: '#9FD6F7' },
  { name: 'Llama', icon: metaColor, color: '#0081FB' },
];

/** Les 24 autres, pour le bandeau défilant. */
export const MORE_PROVIDERS: readonly MoreProvider[] = [
  { name: 'Grok', icon: grok },
  { name: 'GLM', icon: zhipuColor },
  { name: 'Doubao', icon: doubaoColor },
  { name: 'MiniMax', icon: minimaxColor },
  { name: 'Yi', icon: yiColor },
  { name: 'Baichuan', icon: baichuanColor },
  { name: 'Hunyuan', icon: hunyuanColor },
  { name: 'Ernie', icon: wenxinColor },
  { name: 'Step', icon: stepfunColor },
  { name: 'Spark', icon: sparkColor },
  { name: 'SenseNova', icon: sensenovaColor },
  { name: 'InternLM', icon: internlmColor },
  { name: 'Cohere', icon: cohereColor },
  { name: 'Perplexity', icon: perplexityColor },
  { name: 'Phi', icon: microsoftColor },
  { name: 'Nemotron', icon: nvidiaColor },
  { name: 'Solar', icon: upstageColor },
  { name: 'OpenRouter', icon: openrouter },
  { name: 'Groq', icon: groq },
  { name: 'Together', icon: togetherColor },
  { name: 'Fireworks', icon: fireworksColor },
  { name: 'Hugging Face', icon: huggingfaceColor },
  { name: 'Ollama', icon: ollama },
  { name: 'LM Studio', icon: lmstudio },
];
