// ============================================================================
// DERAIL — auth.js
// Wires up "Sign in with Google / GitHub / Discord" using Passport.
// Every provider is OPTIONAL — if its env vars aren't set, that login button
// simply never appears (checked via /auth/providers). Nothing here ever
// touches a password: identity is entirely delegated to the OAuth provider,
// which is the safest way to handle player accounts for a game like this.
// ============================================================================

const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const OAuth2Strategy = require("passport-oauth2").Strategy;

function baseUrl() {
  return process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`;
}

function configuredProviders() {
  const list = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) list.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) list.push("github");
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) list.push("discord");
  return list;
}

function setupPassport() {
  // We don't keep a user database — the OAuth profile itself (a stable
  // provider-scoped id + display name + avatar) IS the account record.
  // It's serialized straight into the signed, httpOnly session cookie.
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${baseUrl()}/auth/google/callback`,
        },
        (accessToken, refreshToken, profile, done) => {
          done(null, {
            provider: "google",
            identityId: `google:${profile.id}`,
            name: profile.displayName || "Player",
            avatar: profile.photos?.[0]?.value || null,
          });
        }
      )
    );
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          callbackURL: `${baseUrl()}/auth/github/callback`,
        },
        (accessToken, refreshToken, profile, done) => {
          done(null, {
            provider: "github",
            identityId: `github:${profile.id}`,
            name: profile.displayName || profile.username || "Player",
            avatar: profile.photos?.[0]?.value || null,
          });
        }
      )
    );
  }

  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    const strategy = new OAuth2Strategy(
      {
        authorizationURL: "https://discord.com/api/oauth2/authorize",
        tokenURL: "https://discord.com/api/oauth2/token",
        clientID: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackURL: `${baseUrl()}/auth/discord/callback`,
        scope: ["identify"],
      },
      (accessToken, refreshToken, profile, done) => {
        // passport-oauth2 doesn't fetch the profile for us — do it manually.
        fetch("https://discord.com/api/users/@me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
          .then((r) => r.json())
          .then((d) => {
            const avatar = d.avatar
              ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png`
              : null;
            done(null, {
              provider: "discord",
              identityId: `discord:${d.id}`,
              name: d.global_name || d.username || "Player",
              avatar,
            });
          })
          .catch((err) => done(err));
      }
    );
    strategy.name = "discord";
    passport.use(strategy);
  }

  return passport;
}

module.exports = { setupPassport, configuredProviders, baseUrl };
