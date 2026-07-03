/**
 * Catalog of local sherpa-onnx STT models available for dictation.
 * Models are downloaded on demand from the k2-fsa GitHub releases and
 * extracted under the OpenChamber speech-models directory.
 *
 * `type` selects the recognizer construction path in the worker:
 * - 'nemo_transducer': encoder/decoder/joiner transducer (Parakeet)
 * - 'whisper': encoder/decoder Whisper export
 * `files` maps logical roles to file names inside the extracted directory.
 */

import path from 'path';

export const LOCAL_STT_MODEL_CATALOG = {
  'parakeet-tdt-0.6b-v2-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v2 (English)',
  },
  'parakeet-tdt-0.6b-v3-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v3 (25 European languages, auto-detected)',
  },
  'whisper-base-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-base',
    files: {
      encoder: 'base-encoder.int8.onnx',
      decoder: 'base-decoder.int8.onnx',
      tokens: 'base-tokens.txt',
    },
    description: 'OpenAI Whisper base (multilingual, smaller and lighter)',
  },
  'whisper-tiny-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-tiny',
    files: {
      encoder: 'tiny-encoder.int8.onnx',
      decoder: 'tiny-decoder.int8.onnx',
      tokens: 'tiny-tokens.txt',
    },
    description: 'OpenAI Whisper tiny (multilingual, fastest and lightest)',
  },
};

export const DEFAULT_LOCAL_STT_MODEL = 'parakeet-tdt-0.6b-v2-int8';

export const LOCAL_STT_MODEL_IDS = Object.keys(LOCAL_STT_MODEL_CATALOG);

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalSttModelId(modelId) {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_STT_MODEL_CATALOG, modelId);
}

/**
 * @param {string} modelId
 */
export function getLocalSttModelSpec(modelId) {
  const spec = LOCAL_STT_MODEL_CATALOG[modelId];
  if (!spec) {
    throw new Error(`Unknown local STT model id: ${modelId}`);
  }
  return {
    id: modelId,
    ...spec,
    requiredFiles: Object.values(spec.files),
  };
}

/**
 * @param {string} modelsDir
 * @param {string} modelId
 * @returns {string}
 */
export function getLocalSttModelDir(modelsDir, modelId) {
  return path.join(modelsDir, getLocalSttModelSpec(modelId).extractedDir);
}
