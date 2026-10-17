CREATE TABLE tags (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  deleted_at timestamptz
);
