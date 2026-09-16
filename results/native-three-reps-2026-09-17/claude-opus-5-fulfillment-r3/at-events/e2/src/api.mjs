const CLIENT_ERRORS = { invalid_request: 400, invalid_quantity: 400, insufficient_stock: 409 };

export function handleReserve(book, body) {
  try {
    return { status: 201, body: book.reserve(body) };
  } catch (error) {
    const status = CLIENT_ERRORS[error?.message];
    return status
      ? { status, body: { error: error.message } }
      : { status: 500, body: { error: 'internal' } };
  }
}
