import type { IRestClientSettings } from '../models/configurationSettings';
import { FormParamEncodingStrategy } from '../models/formParamEncodingStrategy';
import { LogLevel } from '../models/logLevel';
import { PreviewOption } from '../models/previewOption';

/**
 * Settings for running outside the editor.
 *
 * Takes the extension's defaults, minus what makes no sense in a terminal
 * (preview columns, fonts). Declared here, and read from nowhere, because a
 * file that runs in continuous integration has to behave the same on every
 * machine.
 */
export function minimalSettings(): IRestClientSettings {
    return {
        followRedirect: true,
        defaultHeaders: { 'User-Agent': 'vscode-restclient' },
        timeoutInMilliseconds: 0,
        showResponseInDifferentTab: false,
        requestNameAsResponseTabTitle: false,
        proxy: undefined,
        proxyStrictSSL: false,
        rememberCookiesForSubsequentRequests: true,
        excludeHostsForProxy: [],
        environmentVariables: {},
        mimeAndFileExtensionMapping: {},
        previewResponseInUntitledDocument: false,
        hostCertificates: {},
        oidcCertificates: {},
        oidcScopes: [],
        suppressResponseBodyContentTypeValidationWarning: true,
        previewOption: PreviewOption.Full,
        disableHighlightResponseBodyForLargeResponse: true,
        disableAddingHrefLinkForLargeResponse: true,
        largeResponseBodySizeLimitInMB: 5,
        previewColumn: 1,
        previewResponsePanelTakeFocus: false,
        formParamEncodingStrategy: FormParamEncodingStrategy.Automatic,
        addRequestBodyLineIndentationAroundBrackets: true,
        decodeEscapedUnicodeCharacters: false,
        logLevel: LogLevel.Error,
        enableSendRequestCodeLens: false,
        enableCustomVariableReferencesCodeLens: false,
        useContentDispositionFilename: false
    };
}
