<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // There is nowhere to send a guest, so do not try to work one out.
        //
        // Laravel's default is `route('login')`, and it is built *eagerly* — inside the
        // middleware, before the `AuthenticationException` exists, for any request that did not
        // ask for JSON. This app is an API with one static web page and no route named `login`,
        // so that call threw `RouteNotFoundException` and the auth boundary answered 500 — a
        // stack trace under `APP_DEBUG` — instead of 401. Returning `null` is what the handler
        // reads as "no redirect": a 401, JSON or empty, by the rule below.
        //
        // Deliberately not fixed by adding a stub `login` route — an API-only app should not
        // carry a fake web route to satisfy a redirect it must never perform — and deliberately
        // not scoped to `api/*`: the reason there is no redirect is that the app has no login
        // page at all, which is as true of a web route as of an API one. The effect, accepted
        // rather than hidden: a guest-protected web route — there is none today — would answer
        // 401 rather than throw.
        $middleware->redirectGuestsTo(fn () => null);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Anything under `api/` answers JSON, whether or not the caller asked for it.
        //
        // Laravel decides that from `Accept` alone, so a client that omitted the header got an
        // HTML error page from a JSON API — a 401 with no body, a 404 as a styled page, a
        // validation failure as a 302 back to a page this app does not have. The front end always
        // sends the header, so none of that was on a user's path; an auth boundary that answers
        // with anything but its verdict is still worth closing. Not the half that fixed the 500 —
        // that is `redirectGuestsTo` above, which stops the throw; this is what gives the 401 a
        // body.
        //
        // Scoped to `api/*` rather than applied everywhere, so `routes/web.php` keeps rendering
        // its page and its errors as HTML. `expectsJson()` is kept as the second half for the
        // same reason it was the whole rule before: a client that asks for JSON gets it wherever
        // it asks.
        //
        // This only changes how *unhandled* exceptions are rendered. Everything a controller
        // answers deliberately already goes through `App\Http\ApiResponse`, which is a
        // `JsonResponse` either way — so the envelope the client parses is untouched.
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
