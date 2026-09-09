/// <reference types="vite/client" />

import type { MoodPrepApi } from '../shared/types'

declare global {
  interface Window {
    moodprep: MoodPrepApi
  }
}

export {}

