<?php

namespace App\Http\Requests\Encryption;

class DestroyEncryptionKeyRequest extends EncryptionRequest
{
    /**
     * Which credential to forget, from the query string.
     *
     * That the last remaining row cannot be deleted is not expressed here: it depends on how
     * many rows the caller has, which is a question for the controller, and a 422 would be the
     * wrong answer to a request that is perfectly well formed.
     *
     * @return array<string, string>
     */
    public function rules(): array
    {
        return ['credential_id' => 'required|string|max:'.self::MAX_CREDENTIAL_ID];
    }
}
