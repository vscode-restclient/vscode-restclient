import * as assert from 'assert';
import type { TextDocument } from 'vscode';
import { DocumentCache } from '../../models/documentCache';

/** What the editor hands over: an object per open document, identified by its uri and version. */
const documentAt = (uri: string, version: number) => ({ uri: { toString: () => uri }, version }) as unknown as TextDocument;

describe('per-document caches', () => {
    // A closed untitled document gives its name back: the next one opened is
    // Untitled-1 again, at version 1 again. It used to get the file variables
    // of the one before, and a {{name}} it defines was "not defined".
    it('P-103 · a document that reuses a closed one\'s uri and version does not get its cached values', () => {
        const cache = new DocumentCache<string[]>();
        const closed = documentAt('untitled:Untitled-1', 1);
        cache.set(closed, ['old']);

        const reopened = documentAt('untitled:Untitled-1', 1);
        assert.strictEqual(cache.has(reopened), false);
        assert.strictEqual(cache.get(reopened), undefined);

        assert.deepStrictEqual(cache.get(closed), ['old'], 'the document that filled it still reads it');
    });

    it('P-103 · an edit still invalidates, and a version-blind cache keeps its values for the uri', () => {
        const cache = new DocumentCache<string[]>();
        const doc = documentAt('file:///api.http', 1);
        cache.set(doc, ['a']);
        (doc as { version: number }).version = 2;
        assert.strictEqual(cache.get(doc), undefined, 'an edited document is read again');

        // The responses of named requests outlive the document that sent them.
        const responses = new DocumentCache<string[]>(true);
        responses.set(documentAt('file:///api.http', 1), ['login']);
        assert.deepStrictEqual(responses.get(documentAt('file:///api.http', 4)), ['login']);
    });
});
