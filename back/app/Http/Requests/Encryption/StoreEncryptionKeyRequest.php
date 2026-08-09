<?php

namespace App\Http\Requests\Encryption;

class StoreEncryptionKeyRequest extends EncryptionRequest
{
    /**
     * Registering one passkey's wrapped copy of the data key.
     *
     * `label` is the only optional field: a client that has no name for the device is better
     * off sending none than inventing one the user will not recognise.
     *
     * @return array<string, string>
     */
    public function rules(): array
    {
        return [
            'credential_id' => 'required|string|max:'.self::MAX_CREDENTIAL_ID,
            'label' => 'nullable|string|max:'.self::MAX_LABEL,
            'hkdf_salt' => 'required|string|max:'.self::MAX_SALT,
            'wrapped_key' => 'required|string|max:'.self::MAX_WRAPPED_KEY,
        ];
    }
}
