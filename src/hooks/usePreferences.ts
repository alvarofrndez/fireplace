"use client";

import { useSyncExternalStore } from "react";
import {
  getPreferences,
  getServerPreferences,
  subscribePreferences,
  updatePreferences,
  type Preferences,
} from "@/lib/preferences";

export function usePreferences(): [Preferences, (patch: Partial<Preferences>) => void] {
  const preferences = useSyncExternalStore(subscribePreferences, getPreferences, getServerPreferences);
  return [preferences, updatePreferences];
}
