<?php

namespace App\Http\Requests\Encryption;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Shared caps for the encryption endpoints.
 *
 * Every one of these is a request-size guard, not a content rule — the server cannot check
 * these values for anything, since it cannot read them. The numbers come from what the
 * mechanism actually produces, with headroom, so a malformed client is refused rather than
 * writing megabytes into a key table.
 */
abstract class EncryptionRequest extends FormRequest
{
    /** WebAuthn allows a 1023-byte credential id; base64url of one runs to ~1364 characters. */
    protected const MAX_CREDENTIAL_ID = 2048;

    /** A 32-byte HKDF salt is 44 characters of base64. */
    protected const MAX_SALT = 128;

    /** 12-byte IV + 32-byte wrapped DEK + 16-byte GCM tag is 80 characters of base64. */
    protected const MAX_WRAPPED_KEY = 256;

    /** A device name, which the client may send encrypted — same cap as any other field. */
    protected const MAX_LABEL = 2048;

    /**
     * `auth:sanctum` establishes who is calling; every query in the controller is scoped to
     * that user, so a credential belonging to somebody else is not found rather than
     * forbidden.
     */
    public function authorize(): bool
    {
        return true;
    }
}
