"""Проверки реквизитов по официальным алгоритмам контрольных сумм."""

_C10 = [2, 4, 10, 3, 5, 9, 4, 6, 8]
_C11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
_C12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]


def _check(digits: str, coeffs: list[int]) -> int:
    return sum(int(d) * c for d, c in zip(digits, coeffs, strict=False)) % 11 % 10


def is_valid_inn(inn: str) -> bool:
    """ИНН юрлица (10 цифр) или ИП/физлица (12 цифр)."""
    if not inn.isdigit():
        return False
    if len(inn) == 10:
        return _check(inn[:9], _C10) == int(inn[9])
    if len(inn) == 12:
        return _check(inn[:10], _C11) == int(inn[10]) and _check(inn[:11], _C12) == int(inn[11])
    return False
