<?php

namespace App\Http\Requests\Auth;

use Illuminate\Foundation\Http\FormRequest;

class FirebaseLoginRequest extends FormRequest
{
    /**
     * The one public endpoint: this is where a caller becomes a user, so there is nobody to
     * authorize yet. Whether the token is genuine is Firebase's answer, not a validation
     * rule — the controller asks it and returns 401 if it is not.
     */
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, string>
     */
    public function rules(): array
    {
        return ['id_token' => 'required|string'];
    }
}
