import type { httpKeys } from '../keys/http.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const httpEn: AreaDictionary<typeof httpKeys> = {
  'http.auth.expired': 'Authentication has expired. Reload the page',
  'http.request.badContentType': 'The request format is not valid',
  'http.request.tooLarge': 'The request body is too large (the limit is {limit})',
  'http.request.notJson': 'The request body is not JSON',
  'http.request.badShape': 'The request body has the wrong shape',
  'http.entry.title': 'Not authenticated',
  'http.entry.openFromUrl': 'Open the URL with the key that {command} printed.',
  'http.entry.printUrl': 'Run {command} in a terminal to print that URL again at any time.',
  'http.entry.cookieStays': 'Once you open it from there, this browser keeps the key. After that, a bookmark opens it directly.',
};
