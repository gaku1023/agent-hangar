import type { MessageSpec } from '../messageSpec.ts';

export const httpKeys = {
  'http.auth.expired': [],
  'http.request.badContentType': [],
  'http.request.tooLarge': ['limit'],
  'http.request.notJson': [],
  'http.request.badShape': [],
  'http.entry.title': [],
  'http.entry.openFromUrl': ['command'],
  'http.entry.printUrl': ['command'],
  'http.entry.cookieStays': [],
} as const satisfies MessageSpec;
